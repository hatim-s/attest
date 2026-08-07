import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { openReadonlyRunStore, StoreError, type RunStore } from '@attest/core';

import { AttestCliError } from '../../errors.js';

const RUN_STORE_DIRECTORY = '.attest';
const RUN_STORE_FILE = 'runs.db';

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
): Promise<T | undefined> => {
  const storeDirectory = join(root, RUN_STORE_DIRECTORY);
  const storePath = join(storeDirectory, RUN_STORE_FILE);
  let directoryMetadata;
  let storeMetadata;
  try {
    directoryMetadata = await lstat(storeDirectory);
    storeMetadata = await lstat(storePath);
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

  let anchor;
  let store: RunStore | undefined;
  try {
    anchor = await open(resolvedStore, constants.O_RDONLY | constants.O_NOFOLLOW);
    const anchoredMetadata = await anchor.stat();
    const openedStore = await openReadonlyRunStore(resolvedStore);
    store = openedStore;
    const currentMetadata = await lstat(resolvedStore);
    if (
      currentMetadata.isSymbolicLink() ||
      currentMetadata.dev !== anchoredMetadata.dev ||
      currentMetadata.ino !== anchoredMetadata.ino
    ) {
      throw unsafeStore(storePath);
    }
    return await operation(openedStore);
  } catch (error: unknown) {
    if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') throw error;
    throw toSafeStoreError(error, storePath);
  } finally {
    await store?.close();
    await anchor?.close();
  }
};

export { withReadonlyRunStore };
