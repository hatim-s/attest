import * as Effect from 'effect/Effect';
import { lstat, realpath, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { StoreError, type RunStore } from '@attest/core';

import { projectStorePath } from '../../project/project-store-path.js';
import { anchoredCall, openAnchored } from '../../internal/open-anchored.js';
import { LocalError } from '../../errors/index.js';
import { openReadonlyRunStore, withStoreScope } from '../../store/index.js';
import { isProjectPath } from '../../project/project-path.js';
import { withReadCleanup } from './cleanup.js';
import { storeCall } from '../../store/internal/store-effect.js';
import {
  captureRunStoreSnapshot,
  removeRunStoreSnapshot,
  type RunStoreSnapshot,
} from './run-store-snapshot.js';

type ReadonlyRunStoreFileOptions = {
  containmentRoot?: string;
};

const unsafeStore = (path: string): LocalError =>
  new LocalError('project_read_failed', 'The project run store is not a safe file.', {
    path,
  });

const toSafeStoreError = (cause: unknown, path: string): LocalError => {
  if (cause instanceof LocalError) return cause;
  const storeCode = cause instanceof StoreError ? cause.code : 'READ_FAILED';
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
      cause: cause,
    },
  );
};

/** Opens an anchored snapshot and closes its database before removing copied data. */
const withReadonlyRunStoreFile = <T, E, R>(
  storePath: string,
  operation: (store: RunStore) => Effect.Effect<T, E, R>,
  options: ReadonlyRunStoreFileOptions = {},
) =>
  Effect.gen(function* () {
    const storeDirectory = dirname(storePath);

    const metadata = yield* anchoredCall('lstat', storeDirectory, () =>
      lstat(storeDirectory, { bigint: true }),
    ).pipe(
      Effect.catch((failure) =>
        failure.code === 'ENOENT'
          ? Effect.succeed(undefined)
          : Effect.fail(toSafeStoreError(failure.cause, storePath)),
      ),
    );

    if (metadata === undefined) return undefined;

    const storeMetadata = yield* anchoredCall('lstat', storePath, () =>
      lstat(storePath, { bigint: true }),
    ).pipe(
      Effect.catch((failure) =>
        failure.code === 'ENOENT'
          ? Effect.succeed(undefined)
          : Effect.fail(toSafeStoreError(failure.cause, storePath)),
      ),
    );

    if (storeMetadata === undefined) return undefined;

    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !storeMetadata.isFile() ||
      storeMetadata.isSymbolicLink()
    )
      return yield* Effect.fail(unsafeStore(storePath));

    const [resolvedDirectory, resolvedStore, resolvedRoot] = yield* Effect.all(
      [
        storeCall('READ_FAILED', 'Could not resolve store directory.', () =>
          realpath(storeDirectory),
        ),
        storeCall('READ_FAILED', 'Could not resolve store path.', () => realpath(storePath)),
        options.containmentRoot === undefined
          ? Effect.succeed(undefined)
          : storeCall('READ_FAILED', 'Could not resolve containment root.', () =>
              realpath(options.containmentRoot!),
            ),
      ],
      { concurrency: 3 },
    );

    if (
      (resolvedRoot !== undefined && !isProjectPath(resolvedRoot, resolvedDirectory)) ||
      dirname(resolvedStore) !== resolvedDirectory
    )
      return yield* Effect.fail(unsafeStore(storePath));
    let anchor: FileHandle | undefined;
    let snapshot: RunStoreSnapshot | undefined;

    return yield* withReadCleanup(
      Effect.gen(function* () {
        const anchored = yield* openAnchored(resolvedStore, {
          kind: 'file',
          root: resolvedDirectory,
        });

        anchor = anchored.handle;

        if (
          anchored.identity.dev !== storeMetadata.dev ||
          anchored.identity.ino !== storeMetadata.ino
        )
          return yield* Effect.fail(unsafeStore(storePath));
        snapshot = yield* captureRunStoreSnapshot(resolvedStore, anchor);
        const captured = snapshot;

        return yield* withStoreScope((owner) =>
          Effect.gen(function* () {
            const store = yield* openReadonlyRunStore(captured.path, owner);

            return yield* operation(store);
          }),
        );
      }),
      () => [
        ...(snapshot === undefined ? [] : [removeRunStoreSnapshot(snapshot)]),
        ...(anchor === undefined
          ? []
          : [
              storeCall('READ_FAILED', 'Could not close source descriptor.', () => anchor!.close()),
            ]),
      ],
    );
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof StoreError && cause.code === 'RUN_NOT_FOUND'
        ? cause
        : toSafeStoreError(cause, storePath),
    ),
  );

/** Reads the conventional project store, preserving absence as undefined. */
const withReadonlyRunStore = <T, E, R>(
  root: string,
  operation: (store: RunStore) => Effect.Effect<T, E, R>,
) =>
  withReadonlyRunStoreFile(projectStorePath(root), operation, {
    containmentRoot: root,
  });

export { withReadonlyRunStore, withReadonlyRunStoreFile };
