import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { openRunStoreSnapshot, StoreError, type RunStore } from '@attest/core';

import { AttestCliError } from '../../errors.js';
import { captureCleanupFailure, runCleanupSteps, type CleanupFailure } from './cleanup.js';
import {
  captureRunStoreSnapshot,
  removeRunStoreSnapshot,
  type RunStoreSnapshot,
  type RunStoreSnapshotHooks,
} from './run-store-snapshot.js';

const RUN_STORE_DIRECTORY = '.attest';
const RUN_STORE_FILE = 'runs.db';

type ReadonlyRunStoreHooks = {
  beforeAnchorOpen?: () => Promise<void> | void;
  afterSnapshotCaptured?: () => Promise<void> | void;
  snapshot?: RunStoreSnapshotHooks;
  cleanup?: {
    closeStore?: (store: RunStore) => Promise<void>;
    removeSnapshot?: (snapshot: RunStoreSnapshot) => Promise<void>;
    closeAnchor?: (anchor: FileHandle) => Promise<void>;
  };
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const isContainedPath = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
};

const unsafeStore = (path: string): AttestCliError =>
  new AttestCliError('project_read_failed', 'The project run store is not a safe file.', {
    path,
  });

const toSafeStoreError = (error: unknown, path: string): AttestCliError => {
  if (error instanceof AttestCliError) return error;
  const storeCode = error instanceof StoreError ? error.code : 'READ_FAILED';
  const schemaFailure = storeCode === 'SCHEMA_OUTDATED' || storeCode === 'SCHEMA_TOO_NEW';
  return new AttestCliError(
    'project_read_failed',
    schemaFailure
      ? 'The project run store schema is not readable by this Attest version.'
      : 'The project run store could not be read safely.',
    {
      path,
      hint: schemaFailure
        ? 'Use a compatible Attest writer to migrate the store, or upgrade Attest for a newer schema.'
        : 'Check the run-store permissions and integrity, then retry.',
      details: { store_code: storeCode },
      cause: error,
    },
  );
};

/** Opens and anchors the contained run-store inode for one immutable read operation. */
const withReadonlyRunStore = async <T>(
  root: string,
  operation: (store: RunStore) => Promise<T>,
  hooks: ReadonlyRunStoreHooks = {},
): Promise<T | undefined> => {
  const storeDirectory = join(root, RUN_STORE_DIRECTORY);
  const storePath = join(storeDirectory, RUN_STORE_FILE);
  let directoryMetadata: BigIntStats;
  let storeMetadata: BigIntStats;
  try {
    directoryMetadata = await lstat(storeDirectory, { bigint: true });
    storeMetadata = await lstat(storePath, { bigint: true });
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') return undefined;
    throw toSafeStoreError(error, storePath);
  }
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !storeMetadata.isFile() ||
    storeMetadata.isSymbolicLink()
  ) {
    throw unsafeStore(storePath);
  }

  let resolvedRoot: string;
  let resolvedDirectory: string;
  let resolvedStore: string;
  try {
    [resolvedRoot, resolvedDirectory, resolvedStore] = await Promise.all([
      realpath(root),
      realpath(storeDirectory),
      realpath(storePath),
    ]);
  } catch (error: unknown) {
    throw toSafeStoreError(error, storePath);
  }
  if (
    !isContainedPath(resolvedRoot, resolvedDirectory) ||
    dirname(resolvedStore) !== resolvedDirectory
  ) {
    throw unsafeStore(storePath);
  }

  let anchor: FileHandle | undefined;
  let store: RunStore | undefined;
  let snapshot: Awaited<ReturnType<typeof captureRunStoreSnapshot>> | undefined;
  let result: T | undefined;
  let failure: CleanupFailure | undefined;
  try {
    await hooks.beforeAnchorOpen?.();
    anchor = await open(resolvedStore, constants.O_RDONLY | constants.O_NOFOLLOW);
    const anchoredMetadata = await anchor.stat({ bigint: true });
    if (
      !anchoredMetadata.isFile() ||
      anchoredMetadata.dev !== storeMetadata.dev ||
      anchoredMetadata.ino !== storeMetadata.ino
    ) {
      throw unsafeStore(storePath);
    }
    snapshot = await captureRunStoreSnapshot(resolvedStore, anchor, hooks.snapshot);
    await hooks.afterSnapshotCaptured?.();
    const openedStore = await openRunStoreSnapshot(snapshot.path);
    store = openedStore;
    result = await operation(openedStore);
  } catch (error: unknown) {
    failure = captureCleanupFailure(
      error instanceof StoreError && error.code === 'RUN_NOT_FOUND'
        ? error
        : toSafeStoreError(error, storePath),
    );
  }

  // Cleanup must not short-circuit: later steps remove copied data and release the source anchor.
  failure = await runCleanupSteps(failure, [
    ...(store === undefined
      ? []
      : [async () => (hooks.cleanup?.closeStore ?? ((value: RunStore) => value.close()))(store)]),
    ...(snapshot === undefined
      ? []
      : [async () => (hooks.cleanup?.removeSnapshot ?? removeRunStoreSnapshot)(snapshot)]),
    ...(anchor === undefined
      ? []
      : [
          async () =>
            (hooks.cleanup?.closeAnchor ?? ((value: FileHandle) => value.close()))(anchor),
        ]),
  ]);
  if (failure !== undefined) throw failure.error;
  return result;
};

export { withReadonlyRunStore, type ReadonlyRunStoreHooks };
