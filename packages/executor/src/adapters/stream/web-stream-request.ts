import * as Effect from 'effect/Effect';
import { withHttpCleanup } from '../http/http-effects.js';
import { openGuardedResponse, type GuardedHttpFetch } from '../http/guarded-response.js';
import type { MaterializedHttpRequest } from '../http/request-template.js';
import { makeStreamReader } from './stream-reader.js';
import type { StreamHttpResponse } from './stream-transport.js';

/** Transfers guarded headers to a single reader owner with bounded, joined cancellation. */
const openWebStream = Effect.fn('stream.webHeaders')(function* (
  guardedFetch: GuardedHttpFetch,
  request: MaterializedHttpRequest,
  signal: AbortSignal,
  firstByteMs: number,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const opened = yield* restore(
        openGuardedResponse(guardedFetch, request, signal, firstByteMs),
      );

      // Reader acquisition may defect, but the accepted response must still be released.
      const acquired = yield* Effect.exit(Effect.sync(() => opened.response.body?.getReader()));

      if (acquired._tag === 'Failure')
        return yield* withHttpCleanup(Effect.failCause(acquired.cause), [
          Effect.tryPromise({
            try: () => opened.response.body?.cancel() ?? Promise.resolve(),
            catch: (cause) => cause,
          }).pipe(Effect.interruptible, Effect.timeout(100)),
          Effect.sync(opened.release),
        ]);
      const reader = acquired.value;

      const owner = makeStreamReader(() =>
        reader === undefined ? Promise.resolve({ done: true, value: undefined }) : reader.read(),
      );

      const close = withHttpCleanup(Effect.void, [
        ...(reader === undefined
          ? []
          : [
              Effect.tryPromise({ try: () => reader.cancel(), catch: (cause) => cause }).pipe(
                Effect.interruptible,
                Effect.timeout(100),
              ),
              owner.awaitRead,
              Effect.sync(() => reader.releaseLock()),
            ]),
        Effect.sync(opened.release),
      ]);

      return {
        status: opened.response.status,
        headers: Object.fromEntries(opened.response.headers),
        read: owner.read,
        close,
      } satisfies StreamHttpResponse;
    }),
  );
});

export { openWebStream };
