import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

import { errnoCode } from './errno-code.js';

/** Retains syscall context and errno for the registry's ENOENT-only absence mapping. */
class PrivateFileFailure extends Data.TaggedError('PrivateFileFailure')<{
  operation: string;
  path: string;
  cause: unknown;
  code?: string;
}> {}

/** A successful publication must never be repeated merely because cleanup failed. */
class PrivateFileCleanupFailure extends Data.TaggedError('PrivateFileCleanupFailure')<{
  path: string;
  committed: boolean;
  cleanup: Cause.Cause<PrivateFileFailure>;
}> {}

/** Internal annotations preserve cleanup evidence on primary failures, defects and interruption. */
class PrivateFileCleanup extends Context.Service<
  PrivateFileCleanup,
  Cause.Cause<PrivateFileFailure>
>()('attest/PrivateFileCleanup') {}

/** Wraps only a foreign filesystem call, never owned orchestration. */
const privateCall = <A>(operation: string, path: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new PrivateFileFailure({ operation, path, cause, code: errnoCode(cause) }),
  });

/** Lists every directory from the filesystem root down to the parent of `path`. */
const ancestorDirectories = (path: string): string[] => {
  const directory = dirname(resolve(path));
  const root = parse(directory).root;
  const directories: string[] = [];
  let current = root;

  for (const component of directory.slice(root.length).split('/')) {
    current = join(current, component);
    directories.push(current);
  }

  return directories;
};

/** Rejects links because lstat never reports a symlink as a directory. */
const assertDirectory = Effect.fn('privateFile.assertDirectory')(function* (path: string) {
  const metadata = yield* privateCall('lstat', path, () => lstat(path));

  if (!metadata.isDirectory()) {
    return yield* Effect.fail(
      new PrivateFileFailure({
        operation: 'validateAncestor',
        path,
        cause: new Error('Unsafe private file ancestor.'),
      }),
    );
  }
});

/** Rejects symlinked ancestors, retaining ENOENT when an ancestor does not exist. */
const assertPrivateAncestors = Effect.fn('assertPrivateAncestors')(function* (path: string) {
  for (const directory of ancestorDirectories(path)) yield* assertDirectory(directory);
});

/** Creates private ancestors and validates each entry after any concurrent mkdir. */
const createPrivateAncestors = Effect.fn('createPrivateAncestors')(function* (path: string) {
  for (const directory of ancestorDirectories(path)) {
    yield* privateCall('mkdir', directory, () => mkdir(directory, { mode: 0o700 })).pipe(
      Effect.catch((error) => (error.code === 'EEXIST' ? Effect.void : Effect.fail(error))),
    );
    yield* assertDirectory(directory);
  }
}, Effect.uninterruptible);

/**
 * Selects cleanup outcomes explicitly. A primary Cause keeps its reasons and gains diagnostic
 * annotations. A successful operation instead fails with committed evidence when cleanup fails.
 */
const finishPrivateCleanup = <A, E>(
  primary: Exit.Exit<A, E>,
  cleanup: Exit.Exit<unknown, PrivateFileFailure>,
  path: string,
  committed: boolean,
): Effect.Effect<void, PrivateFileCleanupFailure> => {
  if (Exit.isSuccess(cleanup)) return Effect.void;

  if (Exit.isFailure(primary)) {
    // The bracket release must not replace the primary outcome. Its caller attaches this
    // cleanup Cause when selecting the final result below.
    return Effect.void;
  }

  return Effect.fail(new PrivateFileCleanupFailure({ path, committed, cleanup: cleanup.cause }));
};

/** Reads through an owned descriptor; masking joins the Node read before descriptor closure. */
const readPrivateFile = Effect.fn('readPrivateFile')(function* (path: string) {
  yield* assertPrivateAncestors(path);
  let cleanup: Exit.Exit<unknown, PrivateFileFailure> = Exit.void;

  const primary = yield* Effect.exit(
    Effect.acquireUseRelease(
      privateCall('open', path, () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
      (handle) =>
        Effect.gen(function* () {
          const metadata = yield* privateCall('fstat', path, () => handle.stat());

          if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
            return yield* Effect.fail(
              new PrivateFileFailure({
                operation: 'validateFile',
                path,
                cause: new Error('Unsafe private file.'),
              }),
            );
          }

          return yield* privateCall('readFile', path, () => handle.readFile('utf8'));
        }),
      (handle, exit) =>
        Effect.gen(function* () {
          cleanup = yield* Effect.exit(privateCall('close', path, () => handle.close()));
          yield* finishPrivateCleanup(exit, cleanup, path, false);
        }),
    ),
  );

  if (Exit.isFailure(primary) && Exit.isFailure(cleanup)) {
    return yield* Effect.failCause(
      Cause.annotate(primary.cause, Context.make(PrivateFileCleanup, cleanup.cause)),
    );
  }

  return yield* primary;
}, Effect.uninterruptible);

/**
 * Publishes a synced 0600 sibling by rename. The entire write is masked because Node promises
 * cannot be joined by interruption. Close and temporary removal are attempted before return.
 */
const writePrivateFile = Effect.fn('writePrivateFile')(function* (path: string, text: string) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
  let committed = false;
  let cleanupCause: Cause.Cause<PrivateFileFailure> = Cause.empty;

  const recordCleanup = (cleanup: Effect.Effect<unknown, PrivateFileFailure>) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(cleanup);

      if (Exit.isFailure(exit)) cleanupCause = Cause.combine(cleanupCause, exit.cause);
    });

  const primary = yield* Effect.exit(
    Effect.acquireUseRelease(
      Effect.succeed(temporary),
      () =>
        Effect.gen(function* () {
          yield* createPrivateAncestors(path);
          yield* privateCall('chmod', directory, () => chmod(directory, 0o700));
          yield* Effect.acquireUseRelease(
            privateCall('open', temporary, () => open(temporary, 'wx', 0o600)),
            (handle) =>
              Effect.gen(function* () {
                yield* privateCall('writeFile', temporary, () => handle.writeFile(text));
                yield* privateCall('fsync', temporary, () => handle.sync());
              }),
            (handle, exit) =>
              Effect.gen(function* () {
                const closed = yield* Effect.exit(
                  privateCall('close', temporary, () => handle.close()),
                );

                if (Exit.isFailure(closed))
                  cleanupCause = Cause.combine(cleanupCause, closed.cause);
                yield* finishPrivateCleanup(exit, closed, path, false);
              }),
          );
          yield* assertPrivateAncestors(path);
          yield* privateCall('rename', path, () => rename(temporary, path));
          committed = true;
        }),
      () =>
        recordCleanup(
          privateCall('removeTemporary', temporary, () => rm(temporary, { force: true })),
        ),
    ),
  );

  if (Exit.isFailure(primary)) {
    return yield* Effect.failCause(
      Cause.annotate(primary.cause, Context.make(PrivateFileCleanup, cleanupCause)),
    );
  }

  if (cleanupCause.reasons.length > 0) {
    return yield* Effect.fail(
      new PrivateFileCleanupFailure({ path, committed, cleanup: cleanupCause }),
    );
  }
}, Effect.uninterruptible);

export {
  assertPrivateAncestors,
  createPrivateAncestors,
  readPrivateFile,
  writePrivateFile,
  PrivateFileFailure,
  PrivateFileCleanupFailure,
  PrivateFileCleanup,
};
