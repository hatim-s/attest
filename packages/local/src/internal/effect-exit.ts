import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';

/** Keeps the complete runtime cause when a foreign Promise boundary cannot represent it. */
class EffectBoundaryFailure extends Error {
  readonly _tag = 'EffectBoundaryFailure';

  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super('The Effect operation did not complete normally.', { cause: effectCause });
  }
}

/**
 * Temporary forward bridges reject with the original typed error, preserving instanceof and
 * errno mapping. Defects and interruption retain their full Cause rather than becoming an
 * ordinary operational failure. Remove with the last migration bridge in S10.
 */
const valueFromExit = <A, E extends Error>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;

  if (!Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)) {
    for (const reason of exit.cause.reasons) {
      if (Cause.isFailReason(reason)) {
        Object.defineProperty(reason.error, 'effectCause', {
          value: exit.cause,
          configurable: true,
        });
        throw reason.error;
      }
    }
  }

  throw new EffectBoundaryFailure(exit.cause);
};

export { EffectBoundaryFailure, valueFromExit };
