import { lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openTestStore as openStore, run as executeB2 } from '../../../store/_tests_/b1-fixture.js';

import { openEvalProjectStore as acquireEvalStore } from '../eval-project-path.js';
import { startPromiseStoreOwner } from '../../../internal/promise-store-owner.js';

/** Keeps the native eval store inside its explicit owner for the fixture's whole use. */
const openEvalProjectStore = async (root: string) => {
  const lifetime = await startPromiseStoreOwner((owner) => acquireEvalStore(root, owner));

  return { ...lifetime.value, close: () => lifetime.finish() };
};

const directories: string[] = [];

/** Creates and tracks one isolated directory for the store-boundary regression fixtures. */
const createTemporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('openEvalProjectStore', () => {
  it('preserves final SQLite file symlink rejection', async () => {
    const projectRoot = await createTemporaryDirectory('attest-store-boundary-');
    const outside = await createTemporaryDirectory('attest-store-outside-');
    await mkdir(join(projectRoot, '.attest'));
    await symlink(join(outside, 'runs.db'), join(projectRoot, '.attest', 'runs.db'));

    await expect(openEvalProjectStore(projectRoot)).rejects.toMatchObject({
      code: 'run_failed',
      path: '.attest/runs.db',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('restores the canonical directory around an opened compatible SQLite store', async () => {
    const projectRoot = await createTemporaryDirectory('attest-store-boundary-');
    const store = await openEvalProjectStore(projectRoot);
    let runId: string;

    try {
      const run = await executeB2(
        store.runs.createRun({
          configHash: 'sha256:boundary',
          configJson: '{}',
          schemaId: 'attest.eval-run',
        }),
      );

      runId = run.id;
      await executeB2(store.runs.finalizeRun(run.id, 'completed'));
      await expect(executeB2(store.runs.getRun(run.id))).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      await store.close();
    }

    expect((await lstat(join(projectRoot, '.attest'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(projectRoot, '.attest', 'runs.db'))).isFile()).toBe(true);
    expect((await readdir(projectRoot)).filter((entry) => entry.endsWith('.opening'))).toEqual([]);

    const reopened = await openStore(join(projectRoot, '.attest', 'runs.db'));

    try {
      await expect(executeB2(reopened.runs.getRun(runId))).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      await reopened.close();
    }
  });
  it('retains a replacement reverse alias even when its target matches the owned alias', async () => {
    const root = await createTemporaryDirectory('attest-alias-replacement-');
    const store = await openEvalProjectStore(root);
    const alias = (await readdir(root)).find((name) => name.endsWith('.opening'));

    if (alias === undefined) throw new Error('Expected captured store alias.');
    const path = join(root, alias);
    // Rename keeps the original inode alive so the replacement cannot reuse it.
    const original = `${path}.original`;
    await rename(path, original);
    await symlink('.attest', path);
    await expect(store.close()).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(await readlink(path)).toBe('.attest');
  });
});
