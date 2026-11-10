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

export { recoverOrdinary };
