import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureCleanupFailure, runCleanupSteps, type CleanupFailure } from './cleanup.js';

const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_SNAPSHOT_ATTEMPTS = 4;

type FileVersion = BigIntStats;

type RunStoreSnapshot = {
  directory: string;
  path: string;
};

type RunStoreSnapshotHooks = {
  closeWal?: (handle: FileHandle) => Promise<void>;
  removeSnapshot?: (snapshot: RunStoreSnapshot) => Promise<void>;
};

class SnapshotChangedError extends Error {
  constructor() {
    super('Run store changed while its read snapshot was captured.');
    this.name = 'SnapshotChangedError';
  }
}

const sameIdentity = (left: FileVersion, right: FileVersion): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameVersion = (left: FileVersion, right: FileVersion): boolean =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

/** Copies an exact descriptor version without reopening its source pathname. */
const copyFileHandle = async (
  source: FileHandle,
  destination: string,
  expectedSizeValue: bigint,
): Promise<void> => {
  if (expectedSizeValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new SnapshotChangedError();
  const expectedSize = Number(expectedSizeValue);
  const target = await open(destination, 'wx', 0o600);
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let offset = 0;
  let failure: CleanupFailure | undefined;
  try {
    while (offset < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead === 0) throw new SnapshotChangedError();
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten === 0) throw new SnapshotChangedError();
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
  } catch (error: unknown) {
    failure = captureCleanupFailure(error);
  }
  failure = await runCleanupSteps(failure, [async () => target.close()]);
  if (failure !== undefined) throw failure.error;
};

/** Opens an optional WAL with no-follow semantics and verifies its final directory entry. */
const openWal = async (
  path: string,
): Promise<{ handle: FileHandle; version: FileVersion } | undefined> => {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new SnapshotChangedError();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const version = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (current.dev !== version.dev || current.ino !== version.ino) {
      await handle.close();
      throw new SnapshotChangedError();
    }
    return { handle, version };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof Reflect.get(error, 'code') === 'string' &&
      Reflect.get(error, 'code') === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
};

const pathMatchesVersion = async (path: string, version: FileVersion): Promise<boolean> => {
  try {
    const current = await lstat(path, { bigint: true });
    return !current.isSymbolicLink() && current.dev === version.dev && current.ino === version.ino;
  } catch {
    return false;
  }
};

/** Captures one stable main/WAL pair into a disposable directory using only anchored descriptors. */
const captureAttempt = async (
  sourcePath: string,
  source: FileHandle,
  hooks: RunStoreSnapshotHooks,
): Promise<RunStoreSnapshot> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-run-store-snapshot-'));
  const snapshot = { directory, path: join(directory, 'runs.db') };
  const walPath = `${sourcePath}-wal`;
  let wal: Awaited<ReturnType<typeof openWal>> = undefined;
  let failure: CleanupFailure | undefined;
  try {
    const sourceBefore = await source.stat({ bigint: true });
    if (!(await pathMatchesVersion(sourcePath, sourceBefore))) throw new SnapshotChangedError();
    wal = await openWal(walPath);
    await copyFileHandle(source, snapshot.path, sourceBefore.size);
    if (wal !== undefined) {
      await copyFileHandle(wal.handle, `${snapshot.path}-wal`, wal.version.size);
    }

    const sourceAfter = await source.stat({ bigint: true });
    if (!sameVersion(sourceBefore, sourceAfter)) throw new SnapshotChangedError();
    if (!(await pathMatchesVersion(sourcePath, sourceAfter))) throw new SnapshotChangedError();
    if (wal === undefined) {
      try {
        await lstat(walPath);
        throw new SnapshotChangedError();
      } catch (error: unknown) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          Reflect.get(error, 'code') !== 'ENOENT'
        ) {
          throw error;
        }
      }
    } else {
      const walAfter = await wal.handle.stat({ bigint: true });
      if (!sameVersion(wal.version, walAfter) || !(await pathMatchesVersion(walPath, walAfter))) {
        throw new SnapshotChangedError();
      }
    }
  } catch (error: unknown) {
    failure = captureCleanupFailure(error);
  }

  // A failed descriptor close invalidates the handoff, so remove the copied data too.
  failure = await runCleanupSteps(failure, [
    ...(wal === undefined
      ? []
      : [async () => (hooks.closeWal ?? ((handle: FileHandle) => handle.close()))(wal.handle)]),
  ]);
  if (failure !== undefined) {
    const firstFailure = failure;
    const completedFailure = await runCleanupSteps(firstFailure, [
      async () => (hooks.removeSnapshot ?? removeRunStoreSnapshot)(snapshot),
    ]);
    throw (completedFailure ?? firstFailure).error;
  }
  return snapshot;
};

/** Retries bounded concurrent checkpoint changes while never querying a source pathname. */
const captureRunStoreSnapshot = async (
  sourcePath: string,
  source: FileHandle,
  hooks: RunStoreSnapshotHooks = {},
): Promise<RunStoreSnapshot> => {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await captureAttempt(sourcePath, source, hooks);
    } catch (error: unknown) {
      if (!(error instanceof SnapshotChangedError) || attempt === MAX_SNAPSHOT_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw new SnapshotChangedError();
};

/** Removes every copied database and temporary SQLite sidecar after inspection. */
const removeRunStoreSnapshot = async (snapshot: RunStoreSnapshot): Promise<void> => {
  await rm(snapshot.directory, { force: true, recursive: true });
};

export {
  captureRunStoreSnapshot,
  removeRunStoreSnapshot,
  SnapshotChangedError,
  type RunStoreSnapshotHooks,
  type RunStoreSnapshot,
};
