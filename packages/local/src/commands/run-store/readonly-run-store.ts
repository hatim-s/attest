import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { StoreError, type RunStore } from '@attest/core';

import { LocalError } from '../../errors/index.js';
import { openRunStoreSnapshot } from '../../store/index.js';
import { isProjectPath } from '../../project/project-path.js';
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

type ReadonlyRunStoreFileOptions = {
  containmentRoot?: string;
  hooks?: ReadonlyRunStoreHooks;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const unsafeStore = (path: string): LocalError =>
  new LocalError('project_read_failed', 'The project run store is not a safe file.', {
    path,
  });

const toSafeStoreError = (error: unknown, path: string): LocalError => {
  if (error instanceof LocalError) return error;
  const storeCode = error instanceof StoreError ? error.code : 'READ_FAILED';
  const schemaFailure = storeCode === 'SCHEMA_OUTDATED' || storeCode === 'SCHEMA_TOO_NEW';
  return new LocalError(
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

/** Opens and anchors one run-store inode for an immutable read operation. */
const withReadonlyRunStoreFile = async <T>(
  storePath: string,
  operation: (store: RunStore) => Promise<T>,
  options: ReadonlyRunStoreFileOptions = {},
): Promise<T | undefined> => {
  const storeDirectory = dirname(storePath);
  const hooks = options.hooks ?? {};
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

  let resolvedDirectory: string;
  let resolvedStore: string;
  let resolvedContainmentRoot: string | undefined;
  try {
    [resolvedContainmentRoot, resolvedDirectory, resolvedStore] = await Promise.all([
      options.containmentRoot === undefined
        ? Promise.resolve(undefined)
        : realpath(options.containmentRoot),
      realpath(storeDirectory),
      realpath(storePath),
    ]);
  } catch (error: unknown) {
    throw toSafeStoreError(error, storePath);
  }
  if (
    (resolvedContainmentRoot !== undefined &&
      !isProjectPath(resolvedContainmentRoot, resolvedDirectory)) ||
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

/** Reads the conventional project-local store through the anchored snapshot path. */
const withReadonlyRunStore = async <T>(
  root: string,
  operation: (store: RunStore) => Promise<T>,
  hooks: ReadonlyRunStoreHooks = {},
): Promise<T | undefined> =>
  withReadonlyRunStoreFile(join(root, RUN_STORE_DIRECTORY, RUN_STORE_FILE), operation, {
    containmentRoot: root,
    hooks,
  });

export {
  withReadonlyRunStore,
  withReadonlyRunStoreFile,
  type ReadonlyRunStoreFileOptions,
  type ReadonlyRunStoreHooks,
};
