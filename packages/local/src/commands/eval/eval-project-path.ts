import * as Effect from 'effect/Effect';
import { randomUUID } from 'node:crypto';
import { lstat, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { StoreError } from '@attest/core';

import { PROJECT_STORE_PATH } from '../../project/project-store-path.js';
import { LocalError, type LocalErrorCode } from '../../errors/index.js';
import { errnoCode } from '../../internal/errno-code.js';
import { openStore, type StoreScope } from '../../store/index.js';
import { runCleanupSteps } from '../../store/internal/read-cleanup.js';
import { resolveContainedPath } from '../../project/project-path.js';

type CapturedAliases = {
  reverse?: Awaited<ReturnType<typeof lstat>>;
  forward?: Awaited<ReturnType<typeof lstat>>;
};

type PrepareEvalProjectFileOptions = {
  allowAbsolute?: boolean;
  createDirectories?: boolean;
  errorCode: LocalErrorCode;
  message: string;
};

/**
 * Resolves one project-controlled file for eval state or output, creating missing parent
 * directories when asked. Every failure, including filesystem errors, becomes the caller's
 * error so no path detail beyond the configured value reaches the user.
 */
const prepareEvalProjectFile = Effect.fn('prepareEvalProjectFile')(function* (
  projectRoot: string,
  configuredPath: string,
  options: PrepareEvalProjectFileOptions,
) {
  const unsafe = (): LocalError =>
    new LocalError(options.errorCode, options.message, { path: configuredPath });

  return yield* resolveContainedPath(projectRoot, configuredPath, {
    allowAbsolute: options.allowAbsolute,
    createDirectories: options.createDirectories,
    expect: 'file',
    problem: unsafe,
  }).pipe(Effect.mapError((error) => (error instanceof LocalError ? error : unsafe())));
});

const sameDirectoryIdentity = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  left.isDirectory() &&
  right.isDirectory() &&
  !right.isSymbolicLink() &&
  left.dev === right.dev &&
  left.ino === right.ino;

/** Keeps raw filesystem details inside the eval store's typed failure. */
const boundaryFailure = (cause: unknown): StoreError =>
  new StoreError('WRITE_FAILED', 'Eval store boundary operation failed.', { cause });

/** Wraps one foreign filesystem call at the captured store boundary. */
const boundaryCall = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: boundaryFailure });

/** Removes only the temporary symlink owned by this store capture. */
const removeStorePlaceholder = Effect.fn('removeStorePlaceholder')(function* (
  path: string,
  target: string,
) {
  const metadata = yield* boundaryCall(() => lstat(path));

  if (!metadata.isSymbolicLink() || (yield* boundaryCall(() => readlink(path))) !== target) {
    return yield* Effect.fail(
      boundaryFailure(
        new LocalError('run_failed', 'The eval store boundary changed during opening.', {
          path: PROJECT_STORE_PATH,
        }),
      ),
    );
  }

  yield* boundaryCall(() => unlink(path));
});

/** Captures the directory until the explicit owner has closed SQLite and its WAL handles. */
const openEvalProjectStore = Effect.fn('openEvalProjectStore')(function* (
  projectRoot: string,
  owner: StoreScope,
) {
  const storePath = yield* prepareEvalProjectFile(projectRoot, PROJECT_STORE_PATH, {
    createDirectories: true,
    errorCode: 'run_failed',
    message: 'The eval run store is not a safe project file.',
  });

  const directory = dirname(storePath);
  const captureTarget = `.attest-${randomUUID()}.opening`;
  const capturedDirectory = join(dirname(directory), captureTarget);

  return yield* owner.run(
    Effect.gen(function* () {
      const identity = yield* boundaryCall(() => lstat(directory));
      let moved = false;
      let placeholder = false;
      let reverseCreated = false;
      const aliases: CapturedAliases = {};
      // Registered before the DB, so LIFO release closes SQLite before pathname restoration/removal.
      yield* owner.register(
        Effect.suspend(() =>
          runCleanupSteps([
            Effect.gen(function* () {
              if (!placeholder) return;
              const current = yield* boundaryCall(() => lstat(directory));

              if (
                aliases.forward === undefined ||
                current.dev !== aliases.forward.dev ||
                current.ino !== aliases.forward.ino
              )
                return yield* Effect.fail(
                  boundaryFailure(new Error('Eval placeholder identity is unconfirmed.')),
                );
              yield* removeStorePlaceholder(directory, captureTarget);
            }),
            Effect.gen(function* () {
              if (!moved) return;
              const captured = yield* boundaryCall(() => lstat(capturedDirectory));

              if (!sameDirectoryIdentity(identity, captured))
                return yield* Effect.fail(
                  boundaryFailure(new Error('Captured directory changed.')),
                );
              const destination = yield* Effect.result(boundaryCall(() => lstat(directory)));

              if (destination._tag === 'Failure') {
                if (errnoCode(destination.failure.cause) === 'ENOENT') {
                  yield* boundaryCall(() => rename(capturedDirectory, directory));

                  return;
                }

                return yield* Effect.fail(destination.failure);
              }

              return yield* Effect.fail(
                boundaryFailure(new Error('Refusing to replace an existing eval directory.')),
              );
            }),
            Effect.gen(function* () {
              if (!reverseCreated) return;

              if (aliases.reverse === undefined)
                return yield* Effect.fail(
                  boundaryFailure(new Error('Captured alias identity is unconfirmed.')),
                );
              const current = yield* boundaryCall(() => lstat(capturedDirectory));

              if (current.dev !== aliases.reverse.dev || current.ino !== aliases.reverse.ino)
                return yield* Effect.fail(boundaryFailure(new Error('Captured alias changed.')));
              yield* removeStorePlaceholder(capturedDirectory, basename(directory));
            }),
          ]),
        ),
      );
      yield* boundaryCall(() => rename(directory, capturedDirectory));
      moved = true;

      if (!sameDirectoryIdentity(identity, yield* boundaryCall(() => lstat(capturedDirectory)))) {
        return yield* Effect.fail(
          new LocalError('run_failed', 'The eval store boundary changed before opening.', {
            path: PROJECT_STORE_PATH,
          }),
        );
      }

      yield* boundaryCall(() => symlink(captureTarget, directory));
      placeholder = true;
      aliases.forward = yield* boundaryCall(() => lstat(directory));
      const store = yield* openStore(join(capturedDirectory, basename(storePath)), owner);
      yield* removeStorePlaceholder(directory, captureTarget);
      placeholder = false;
      yield* boundaryCall(() => rename(capturedDirectory, directory));
      moved = false;
      yield* boundaryCall(() => symlink(basename(directory), capturedDirectory));
      reverseCreated = true;
      aliases.reverse = yield* boundaryCall(() => lstat(capturedDirectory));

      return store;
    }),
  );
});

export { openEvalProjectStore, prepareEvalProjectFile };
