import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';

/** Projects typed read errors into the existing CLI error serializer without losing the Cause. */
const readExitValue = <A, E extends Error>(exit: Exit.Exit<A, E>): A => {
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

  throw new Error('The read operation did not complete normally.', { cause: exit.cause });
};

export { readExitValue };
