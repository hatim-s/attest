import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { StoreError } from '@attest/core';
import { finishStoreCleanup } from './store-effect.js';

type CleanupStep = Effect.Effect<unknown, unknown>;

/** Attempts all releases and retains every failed Exit, including defects. */
const runCleanupSteps = Effect.fn('runCleanupSteps')(function* (steps: readonly CleanupStep[]) {
  let result: Exit.Exit<void, StoreError> = Exit.void;

  for (const step of steps) {
    const exit = yield* Effect.exit(step);

    if (Exit.isFailure(exit)) {
      const failure = Cause.fail(
        new StoreError('READ_FAILED', 'Read resource cleanup failed.', { cause: exit.cause }),
      );

      result = Exit.isFailure(result)
        ? Exit.failCause(Cause.combine(result.cause, failure))
        : Exit.failCause(failure);
    }
  }

  return yield* result;
});

/** Masks acquisition and cleanup so foreign descriptor work settles before dependent release. */
const withReadCleanup = <A, E, R>(
  use: Effect.Effect<A, E, R>,
  steps: () => readonly CleanupStep[],
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const primary = yield* Effect.exit(use);
      const cleanup = yield* Effect.exit(runCleanupSteps(steps()));

      if (Exit.isSuccess(primary) && Exit.isFailure(cleanup)) {
        return yield* Effect.fail(
          new StoreError('READ_FAILED', 'Read work completed but cleanup failed.', {
            cause: { primary, cleanup: cleanup.cause },
          }),
        );
      }

      return yield* finishStoreCleanup(primary, cleanup);
    }),
  );

export { runCleanupSteps, withReadCleanup, type CleanupStep };
