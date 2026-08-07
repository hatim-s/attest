import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCliError } from '../../errors.js';
import {
  PROJECT_LOCK_FILE,
  PROJECT_LOCK_SCHEMA,
  acquireProjectLock,
  inspectProjectLock,
  releaseProjectLock,
  unlockStaleProjectLock,
  type ProjectLockMetadata,
} from './project-lock.js';

const temporaryDirectories: string[] = [];

/** Creates an isolated project root for lock lifecycle tests. */
const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-project-lock-'));
  temporaryDirectories.push(root);
  return root;
};

/** Writes synthetic lock metadata without relying on another process. */
const writeLock = async (root: string, metadata: ProjectLockMetadata): Promise<void> => {
  const path = join(root, PROJECT_LOCK_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('project lock', () => {
  it('rejects a concurrent writer while preserving the live owner', async () => {
    const root = await createRoot();
    const first = await acquireProjectLock(root);
    let failure: unknown;
    try {
      await acquireProjectLock(root);
    } catch (error: unknown) {
      failure = error;
    }

    expect(serializeCliError(failure)).toMatchObject({
      error: { code: 'project_locked', details: { lock_state: 'live' } },
      exitCode: 3,
    });
    expect((await inspectProjectLock(root)).state).toBe('live');
    await releaseProjectLock(first);
    expect(await inspectProjectLock(root)).toEqual({ state: 'absent' });
  });

  it('requires explicit stale unlock and keeps a dry-run byte-for-byte write-free', async () => {
    const root = await createRoot();
    const stale: ProjectLockMetadata = {
      schema: PROJECT_LOCK_SCHEMA,
      owner_token: 'stale-owner',
      pid: 2_147_483_647,
      process_start_identity: 'old-start',
      hostname: (await import('node:os')).hostname(),
      created_at: '2026-08-07T00:00:00.000Z',
    };
    await writeLock(root, stale);
    const lockPath = join(root, PROJECT_LOCK_FILE);
    const before = await readFile(lockPath);

    let acquireFailure: unknown;
    try {
      await acquireProjectLock(root);
    } catch (error: unknown) {
      acquireFailure = error;
    }
    expect(serializeCliError(acquireFailure)).toMatchObject({
      error: { code: 'project_lock_stale', retryable: false },
      exitCode: 3,
    });

    expect(await unlockStaleProjectLock(root, { dryRun: true })).toEqual(stale);
    expect(await readFile(lockPath)).toEqual(before);
    await unlockStaleProjectLock(root);
    expect(await inspectProjectLock(root)).toEqual({ state: 'absent' });
  });

  it('never removes malformed lock metadata automatically', async () => {
    const root = await createRoot();
    const lockPath = join(root, PROJECT_LOCK_FILE);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, '{"pid":"unknown"}\n');

    let failure: unknown;
    try {
      await unlockStaleProjectLock(root);
    } catch (error: unknown) {
      failure = error;
    }

    expect(serializeCliError(failure)).toMatchObject({
      error: { code: 'project_locked', details: { lock_state: 'invalid' } },
    });
    expect(await readFile(lockPath, 'utf8')).toBe('{"pid":"unknown"}\n');
  });
});
