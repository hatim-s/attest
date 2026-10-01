import type { BigIntStats } from 'node:fs';
import { lstat, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { StoreError, type RunStore } from '@attest/core';

import { errnoCode } from '../../internal/errno-code.js';
import { openAnchored } from '../../internal/open-anchored.js';
import { LocalError } from '../../errors/index.js';
import { openRunStoreSnapshot } from '../../store/index.js';
import { isProjectPath } from '../../project/project-path.js';
import { rethrowAfterCleanup, runCleanupSteps, type CleanupStep } from './cleanup.js';
import {
  captureRunStoreSnapshot,
  removeRunStoreSnapshot,
  type RunStoreSnapshot,
} from './run-store-snapshot.js';

const RUN_STORE_DIRECTORY = '.attest';
const RUN_STORE_FILE = 'runs.db';

type ReadonlyRunStoreFileOptions = {
  containmentRoot?: string;
};

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
  let directoryMetadata: BigIntStats;
  let storeMetadata: BigIntStats;
  try {
    directoryMetadata = await lstat(storeDirectory, { bigint: true });
    storeMetadata = await lstat(storePath, { bigint: true });
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return undefined;
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
  let snapshot: RunStoreSnapshot | undefined;
  // Cleanup must not short-circuit: later steps remove copied data and release the source anchor.
  const cleanupSteps = (): CleanupStep[] => {
    const [openedStore, capturedSnapshot, openedAnchor] = [store, snapshot, anchor];
    const steps: CleanupStep[] = [];
    if (openedStore !== undefined) steps.push(async () => openedStore.close());
    if (capturedSnapshot !== undefined) {
      steps.push(async () => removeRunStoreSnapshot(capturedSnapshot));
    }
    if (openedAnchor !== undefined) steps.push(async () => openedAnchor.close());
    return steps;
  };
  let result: T;
  try {
    const anchored = await openAnchored(resolvedStore, { kind: 'file', root: resolvedDirectory });
    anchor = anchored.handle;
    // The anchor must be the inode inspected before containment checks, not a later swap.
    if (
      anchored.identity.dev !== storeMetadata.dev ||
      anchored.identity.ino !== storeMetadata.ino
    ) {
      throw unsafeStore(storePath);
    }
    snapshot = await captureRunStoreSnapshot(resolvedStore, anchor);
    const openedStore = await openRunStoreSnapshot(snapshot.path);
    store = openedStore;
    result = await operation(openedStore);
  } catch (error: unknown) {
    const failure =
      error instanceof StoreError && error.code === 'RUN_NOT_FOUND'
        ? error
        : toSafeStoreError(error, storePath);
    return rethrowAfterCleanup(failure, cleanupSteps());
  }
  await runCleanupSteps(cleanupSteps());
  return result;
};

/** Reads the conventional project-local store through the anchored snapshot path. */
const withReadonlyRunStore = async <T>(
  root: string,
  operation: (store: RunStore) => Promise<T>,
): Promise<T | undefined> =>
  withReadonlyRunStoreFile(join(root, RUN_STORE_DIRECTORY, RUN_STORE_FILE), operation, {
    containmentRoot: root,
  });

export { withReadonlyRunStore, withReadonlyRunStoreFile };
