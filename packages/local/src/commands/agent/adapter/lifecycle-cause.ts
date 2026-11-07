import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

/** Projects a single expected failure; defects and mixed Causes remain native. */
const recoverOrdinary = <A, B, E extends Error, E2 extends Error, R, R2>(
  operation: Effect.Effect<A, E, R>,
  recover: (error: E, cause: Cause.Cause<E>) => Effect.Effect<B, E2, R2>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(operation);

    if (Exit.isSuccess(result)) return result.value;
    const reason = result.cause.reasons[0];

    if (result.cause.reasons.length === 1 && reason !== undefined && Cause.isFailReason(reason))
      return yield* recover(reason.error, result.cause);

    return yield* Effect.failCause(result.cause);
  });

/** Keeps the primary Cause and attaches every release Cause without replacing its classification. */
const finishWithRelease = <A, E extends Error>(
  primary: Exit.Exit<A, E>,
  releases: readonly Exit.Exit<unknown, Error>[],
) => {
  const causes = releases.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []));

  if (Exit.isFailure(primary))
    return Effect.failCause(
      causes.length === 0
        ? primary.cause
        : causes.reduce((left, right) => Cause.combine(left, right), primary.cause),
    );

  if (causes.length > 0)
    return Effect.failCause(
      causes.reduce((left, right) => Cause.combine(left, right), Cause.empty),
    );

  return Effect.succeed(primary.value);
};

export { recoverOrdinary, finishWithRelease };
