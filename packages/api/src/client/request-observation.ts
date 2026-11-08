import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { flow } from 'effect/Function';
import { foreignMessage } from '@attest/contracts';
import { ApiRequestError } from './api-error.js';

/** Internal evidence never authorizes replay of an opaque remote mutation. */
type RequestReceipt = {
  completion: 'pending' | 'observed';
  cleanup: 'unneeded' | 'pending' | 'confirmed' | 'unconfirmed';
  cleanupFailure?: ApiRequestError;
};

/**
 * BOUNDARY: a foreign Promise rejection or throw can carry any value. This wraps it once as the
 * ApiRequestError cause and keeps the rejection's own Error message.
 */
const toApiRequestError =
  (fallback: string) =>
  (cause: unknown): ApiRequestError =>
    new ApiRequestError({ message: foreignMessage(cause, fallback), cause });

class RequestObservation extends Context.Service<RequestObservation, RequestReceipt>()(
  'attest/RequestObservation',
) {}

/** Observes one foreign operation, joins abort for a bounded interval, and retains late cleanup. */
const observeRequest = <A>(
  operation: () => Promise<A>,
  abort: () => void,
  releaseLate?: (value: A) => Promise<void>,
): Effect.Effect<A, ApiRequestError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const done = Deferred.makeUnsafe<A, ApiRequestError>();
      const receipt: RequestReceipt = { completion: 'pending', cleanup: 'unneeded' };
      let abandoned = false;
      let released = false;

      const release = (value: A): void => {
        if (releaseLate === undefined || released) return;
        released = true;
        receipt.cleanup = 'pending';
        void releaseLate(value).then(
          () => {
            receipt.cleanup = 'confirmed';
          },
          flow(toApiRequestError('Late response release failed.'), (failure) => {
            receipt.cleanup = 'unconfirmed';
            receipt.cleanupFailure = failure;
          }),
        );
      };

      const begin = yield* Effect.exit(
        Effect.try({
          // The callbacks publish the outcome through `done`, so the chained Promise is dropped.
          try: () => {
            void operation().then(
              (value) => {
                receipt.completion = 'observed';
                // Settle first so a synchronous throw from the late release cannot strand `done`.
                Deferred.doneUnsafe(done, Effect.succeed(value));

                if (abandoned) release(value);
              },
              flow(
                toApiRequestError('API operation failed; remote completion is unknown.'),
                (failure) => {
                  receipt.completion = 'observed';
                  Deferred.doneUnsafe(done, Effect.fail(failure));
                },
              ),
            );
          },
          catch: toApiRequestError('API dispatch failed.'),
        }),
      );

      if (Exit.isFailure(begin)) return yield* Effect.failCause(begin.cause);
      const primary = yield* Effect.exit(restore(Deferred.await(done)));

      if (Exit.isSuccess(primary)) return primary.value;

      if (Cause.hasInterrupts(primary.cause)) {
        abandoned = true;
        receipt.cleanup = 'pending';
        abort();

        // A foreign fetch may ignore abort. Its late callback still owns response release.
        const observed = yield* Effect.exit(
          Deferred.await(done).pipe(Effect.interruptible, Effect.timeoutOption(1_000)),
        );

        if (Exit.isSuccess(observed) && observed.value._tag === 'Some')
          release(observed.value.value);

        if (receipt.completion === 'pending') receipt.cleanup = 'unconfirmed';
      }

      return yield* Effect.failCause(
        Cause.annotate(primary.cause, Context.make(RequestObservation, receipt)),
      );
    }),
  );

export { observeRequest, RequestObservation };
