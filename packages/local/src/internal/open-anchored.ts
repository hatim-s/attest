import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import { errnoCode } from './errno-code.js';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';

import { isProjectPath } from '../project/project-path.js';

type AnchoredEntry = {
  handle: FileHandle;
  identity: BigIntStats;
  /** The realpath of the opened entry. */
  path: string;
};

type OpenAnchoredOptions = {
  kind: 'directory' | 'file';
  /** Resolved directory the entry must stay inside. */
  root: string;
};

/** Retains the failing syscall and original errno without exposing raw paths in diagnostics. */
class AnchoredFileFailure extends Data.TaggedError('AnchoredFileFailure')<{
  operation: string;
  path: string;
  cause: unknown;
  code?: string;
}> {}

/** Carries close evidence after a successful descriptor operation. */
class AnchoredCleanupFailure extends Data.TaggedError('AnchoredCleanupFailure')<{
  path: string;
  cleanup: Cause.Cause<AnchoredFileFailure>;
}> {}

/** Attaches cleanup evidence without replacing a primary failure, defect or interruption. */
class AnchoredCleanup extends Context.Service<AnchoredCleanup, Cause.Cause<AnchoredFileFailure>>()(
  'attest/AnchoredCleanup',
) {}

/** Wraps one foreign filesystem call. */
const anchoredCall = <A>(operation: string, path: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new AnchoredFileFailure({ operation, path, cause, code: errnoCode(cause) }),
  });

/**
 * Transfers an owned descriptor after masked open and validation. Native callers must register
 * release immediately. Temporary Phase B Promise callers own their existing try/finally close.
 * Failed validation closes here; interruption cannot abandon a pending Node open.
 */
const openAnchored = Effect.fn('openAnchored')(function* (
  path: string,
  options: OpenAnchoredOptions,
): Effect.fn.Return<AnchoredEntry, AnchoredFileFailure> {
  const handle = yield* anchoredCall('open', path, () =>
    open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
  );

  const validated = yield* Effect.exit(
    Effect.gen(function* () {
      const identity = yield* anchoredCall('fstat', path, () => handle.stat({ bigint: true }));
      const pathIdentity = yield* anchoredCall('lstat', path, () => lstat(path, { bigint: true }));
      const resolvedPath = yield* anchoredCall('realpath', path, () => realpath(path));
      const kindMatches = options.kind === 'file' ? identity.isFile() : identity.isDirectory();

      if (!kindMatches)
        return yield* Effect.fail(
          new AnchoredFileFailure({
            operation: 'validateKind',
            path,
            cause: new Error(`The opened entry is not a ${options.kind}.`),
          }),
        );

      if (
        pathIdentity.isSymbolicLink() ||
        identity.dev !== pathIdentity.dev ||
        identity.ino !== pathIdentity.ino ||
        !isProjectPath(options.root, resolvedPath)
      ) {
        return yield* Effect.fail(
          new AnchoredFileFailure({
            operation: 'validateIdentity',
            path,
            cause: new Error(
              `The ${options.kind} changed identity or left its root while opening.`,
            ),
          }),
        );
      }

      return { handle, identity, path: resolvedPath };
    }),
  );

  if (Exit.isFailure(validated)) {
    const cleanup = yield* Effect.exit(anchoredCall('close', path, () => handle.close()));

    return yield* Effect.failCause(
      Exit.isFailure(cleanup)
        ? Cause.annotate(validated.cause, Context.make(AnchoredCleanup, cleanup.cause))
        : validated.cause,
    );
  }

  return validated.value;
}, Effect.uninterruptible);

/** Brackets native descriptor use and joins pending Node reads before closing. */
const withAnchored = Effect.fn('withAnchored')(function* <A, E>(
  path: string,
  options: OpenAnchoredOptions,
  use: (entry: AnchoredEntry) => Effect.Effect<A, E>,
) {
  let cleanup: Exit.Exit<unknown, AnchoredFileFailure> = Exit.void;

  const primary = yield* Effect.exit(
    Effect.acquireUseRelease(
      openAnchored(path, options),
      (entry) => Effect.suspend(() => use(entry)),
      (entry) =>
        Effect.gen(function* () {
          cleanup = yield* Effect.exit(
            anchoredCall('close', entry.path, () => entry.handle.close()),
          );
        }),
    ),
  );

  if (Exit.isFailure(cleanup)) {
    if (Exit.isFailure(primary))
      return yield* Effect.failCause(
        Cause.annotate(primary.cause, Context.make(AnchoredCleanup, cleanup.cause)),
      );

    return yield* Effect.fail(new AnchoredCleanupFailure({ path, cleanup: cleanup.cause }));
  }

  return yield* primary;
}, Effect.uninterruptible);

export {
  openAnchored,
  withAnchored,
  anchoredCall,
  AnchoredFileFailure,
  AnchoredCleanupFailure,
  AnchoredCleanup,
  type AnchoredEntry,
};
