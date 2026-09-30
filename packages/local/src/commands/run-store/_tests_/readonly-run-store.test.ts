import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openStore } from '../../../store/index.js';
import { withReadonlyRunStore } from '../readonly-run-store.js';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-readonly-run-store-'));
  temporaryDirectories.push(directory);
  return directory;
};

/** Captures exact file bytes in one directory, keyed by sorted file name. */
const snapshotDirectory = async (directory: string): Promise<Record<string, Buffer>> => {
  const entries = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [entry, await readFile(join(directory, entry))] as const),
    ),
  );
};

/** Writes a closed store with one run and returns its bytes. */
const createStoreBytes = async (): Promise<Buffer> => {
  const path = join(await temporaryDirectory(), 'runs.db');
  const store = await openStore(path);
  await store.runs.createRun({ schemaId: 'attest.project', configHash: 'hash', configJson: '{}' });
  await store.close();
  return readFile(path);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('withReadonlyRunStore', () => {
  it('reads committed WAL rows from a live writer without changing source files', async () => {
    const root = await temporaryDirectory();
    const storeDirectory = join(root, '.attest');
    await mkdir(storeDirectory);
    const writer = await openStore(join(storeDirectory, 'runs.db'));
    try {
      const run = await writer.runs.createRun({
        schemaId: 'attest.project',
        configHash: 'live-wal',
        configJson: '{}',
      });
      expect(await readdir(storeDirectory)).toContain('runs.db-wal');
      const before = await snapshotDirectory(storeDirectory);

      await expect(
        withReadonlyRunStore(root, async (store) => store.getRun(run.id)),
      ).resolves.toMatchObject({ id: run.id, configHash: 'live-wal' });
      expect(await snapshotDirectory(storeDirectory)).toEqual(before);
    } finally {
      await writer.close();
    }
  });

  it('rejects a symlinked store file or store directory without touching the outside copy', async () => {
    const bytes = await createStoreBytes();
    const outside = await temporaryDirectory();
    const outsideStore = join(outside, 'runs.db');
    await writeFile(outsideStore, bytes);

    const fileLink = await temporaryDirectory();
    await mkdir(join(fileLink, '.attest'));
    await symlink(outsideStore, join(fileLink, '.attest', 'runs.db'));
    const directoryLink = await temporaryDirectory();
    await symlink(outside, join(directoryLink, '.attest'));

    for (const root of [fileLink, directoryLink]) {
      await expect(
        withReadonlyRunStore(root, async (store) => store.listRuns()),
      ).rejects.toMatchObject({ code: 'project_read_failed' });
    }
    expect(await readFile(outsideStore)).toEqual(bytes);
    expect(await readdir(outside)).toEqual(['runs.db']);
  });
});
