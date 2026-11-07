import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';

/** Preserves expected errors at the test's foreign assertion boundary. */
const valueFromExit = <A, E extends Error>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;

  if (!Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)) {
    for (const reason of exit.cause.reasons) if (Cause.isFailReason(reason)) throw reason.error;
  }

  throw new Error('Native test operation failed.', { cause: exit.cause });
};

export { valueFromExit };
