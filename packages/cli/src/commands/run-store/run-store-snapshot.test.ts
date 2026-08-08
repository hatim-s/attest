import { access, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  captureRunStoreSnapshot,
  removeRunStoreSnapshot,
  SnapshotChangedError,
} from './run-store-snapshot.js';

it('removes copied data and preserves the first failure when WAL cleanup fails', async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'attest-snapshot-cleanup-'));
  const sourcePath = join(sourceDirectory, 'runs.db');
  const walCloseError = new Error('injected WAL close failure');
  const removalError = new Error('injected removal failure');
  const cleanupOrder: string[] = [];
  let snapshotDirectory: string | undefined;
  await writeFile(sourcePath, 'database');
  await writeFile(`${sourcePath}-wal`, 'committed wal');
  const source = await open(sourcePath, 'r');
  try {
    await expect(
      captureRunStoreSnapshot(sourcePath, source, {
        closeWal: async (handle) => {
          cleanupOrder.push('wal');
          await handle.close();
          throw walCloseError;
        },
        removeSnapshot: async (snapshot) => {
          cleanupOrder.push('snapshot');
          snapshotDirectory = snapshot.directory;
          await removeRunStoreSnapshot(snapshot);
          throw removalError;
        },
      }),
    ).rejects.toBe(walCloseError);
    expect(cleanupOrder).toEqual(['wal', 'snapshot']);
    await expect(access(snapshotDirectory as string)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await source.close();
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});

it('rejects a regular WAL replacement before copying any snapshot bytes', async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'attest-snapshot-wal-swap-'));
  const sourcePath = join(sourceDirectory, 'runs.db');
  const walPath = `${sourcePath}-wal`;
  let swaps = 0;
  let closedHandles = 0;
  let removedSnapshots = 0;
  await writeFile(sourcePath, 'database');
  await writeFile(walPath, 'intended wal');
  const source = await open(sourcePath, 'r');
  try {
    await expect(
      captureRunStoreSnapshot(sourcePath, source, {
        beforeWalOpen: async (path) => {
          await rename(path, `${path}.replaced-${swaps}`);
          await writeFile(path, `foreign wal ${swaps}`);
          swaps += 1;
        },
        closeWal: async (handle) => {
          closedHandles += 1;
          await handle.close();
        },
        removeSnapshot: async (snapshot) => {
          removedSnapshots += 1;
          expect(await readdir(snapshot.directory)).toEqual([]);
          await removeRunStoreSnapshot(snapshot);
        },
      }),
    ).rejects.toBeInstanceOf(SnapshotChangedError);
    expect(swaps).toBe(4);
    expect(closedHandles).toBe(4);
    expect(removedSnapshots).toBe(4);
  } finally {
    await source.close();
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});
