import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

import { errnoCode } from './errno-code.js';

/** Retains unexpected signal-zero failures rather than declaring a live owner stale. */
class ProcessPresenceFailure extends Data.TaggedError('ProcessPresenceFailure')<{
  pid: number;
  code?: string;
  cause: unknown;
}> {}

/** Checks existence without delivering a signal; EPERM proves existence and ESRCH absence. */
const isProcessPresent = Effect.fn('isProcessPresent')(function* (pid: number) {
  return yield* Effect.try({
    try: () => {
      process.kill(pid, 0);

      return true;
    },
    catch: (cause) => new ProcessPresenceFailure({ pid, code: errnoCode(cause), cause }),
  }).pipe(
    Effect.catch((error) => {
      if (error.code === 'EPERM') return Effect.succeed(true);

      if (error.code === 'ESRCH') return Effect.succeed(false);

      return Effect.fail(error);
    }),
  );
});

export { isProcessPresent, ProcessPresenceFailure };
