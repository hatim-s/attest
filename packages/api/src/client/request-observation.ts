import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

/** Internal evidence never authorizes replay of an opaque remote mutation. */
type RequestReceipt = {
  completion: 'pending' | 'observed';
  cleanup: 'unneeded' | 'pending' | 'confirmed' | 'unconfirmed';
  cleanupFailure?: Error;
};

class RequestObservation extends Context.Service<RequestObservation, RequestReceipt>()(
  'attest/RequestObservation',
) {}

/** Observes one foreign operation, joins abort for a bounded interval, and retains late cleanup. */
const observeRequest = <A>(
  operation: () => Promise<A>,
  abort: () => void,
  releaseLate?: (value: A) => Promise<void>,
): Effect.Effect<A, Error> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const done = Deferred.makeUnsafe<A, Error>();
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
          // BOUNDARY: Promise rejection values are normalized to Error before retaining cleanup evidence.
          (error: unknown) => {
            receipt.cleanup = 'unconfirmed';
            receipt.cleanupFailure =
              error instanceof Error
                ? error
                : new Error('Late response release failed.', { cause: error });
          },
        );
      };

      const begin = yield* Effect.exit(
        Effect.try({
          try: () =>
            operation().then(
              (value) => {
                receipt.completion = 'observed';

                if (abandoned) release(value);
                Deferred.doneUnsafe(done, Effect.succeed(value));
              },
              // BOUNDARY: foreign Promise rejection values are normalized once before publishing the Exit.
              (error: unknown) => {
                receipt.completion = 'observed';
                Deferred.doneUnsafe(
                  done,
                  Effect.fail(
                    error instanceof Error
                      ? error
                      : new Error('API operation failed; remote completion is unknown.', {
                          cause: error,
                        }),
                  ),
                );
              },
            ),
          catch: (error) =>
            error instanceof Error ? error : new Error('API dispatch failed.', { cause: error }),
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
