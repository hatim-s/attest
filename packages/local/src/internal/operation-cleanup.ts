import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { LocalError } from '../errors/local-error.js';

/** Retains release diagnostics on the primary Cause without exposing them in public JSON. */
class OperationCleanup extends Context.Service<OperationCleanup, Cause.Cause<Error>>()(
  'attest/OperationCleanup',
) {}

/** Captures every release Exit and retains completed evidence when release alone fails. */
const withOperationCleanup = <A, E extends Error, R, E2 extends Error, R2>(
  use: Effect.Effect<A, E, R>,
  release: Effect.Effect<unknown, E2, R2>,
  code: ConstructorParameters<typeof LocalError>[0] = 'cloud_request_failed',
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const primary = yield* Effect.exit(restore(use));
      const cleanup = yield* Effect.exit(release);

      if (Exit.isFailure(cleanup)) {
        if (Exit.isFailure(primary))
          return yield* Effect.failCause(
            Cause.annotate(
              primary.cause,
              Context.make(
                OperationCleanup,
                Cause.combine(
                  Context.getOrUndefined(Cause.annotations(primary.cause), OperationCleanup) ??
                    Cause.empty,
                  cleanup.cause,
                ),
              ),
              { overwrite: true },
            ),
          );

        return yield* Effect.fail(
          new LocalError(code, 'Operation completed but cleanup failed.', {
            cause: { primary, cleanup },
            details: code === 'project_saved_cleanup_failed' ? { committed: true } : undefined,
          }),
        );
      }

      return yield* primary;
    }),
  );

/** Retains every failed release without changing the primary Cause classification. */
class OperationReleases extends Context.Service<
  OperationReleases,
  readonly Exit.Exit<unknown, Error>[]
>()('attest/OperationReleases') {}

/** Retains completed work when mandatory release fails after success. */
class OperationCompletion extends Context.Service<
  OperationCompletion,
  Exit.Exit<unknown, unknown>
>()('attest/OperationCompletion') {}

/** Applies primary precedence after the owner has attempted every release. */
const finishOperation = <A, E extends Error>(
  primary: Exit.Exit<A, E>,
  releases: readonly Exit.Exit<unknown, Error>[],
): Effect.Effect<A, E | Error> => {
  const failed = releases.filter(Exit.isFailure);

  if (failed.length === 0) return primary;

  if (Exit.isSuccess(primary)) {
    const cause: Cause.Cause<Error> = failed.reduce<Cause.Cause<Error>>(
      (left, exit) => Cause.combine(left, exit.cause),
      Cause.empty,
    );

    return Effect.failCause(
      Cause.annotate(
        Cause.annotate(cause, Context.make(OperationCompletion, primary)),
        Context.make(OperationReleases, releases),
      ),
    );
  }

  const previous =
    Context.getOrUndefined(Cause.annotations(primary.cause), OperationReleases) ?? [];

  return Effect.failCause(
    Cause.annotate(primary.cause, Context.make(OperationReleases, [...previous, ...releases]), {
      overwrite: true,
    }),
  );
};

export {
  withOperationCleanup,
  OperationCleanup,
  OperationReleases,
  OperationCompletion,
  finishOperation,
};
