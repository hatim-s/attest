import * as Effect from 'effect/Effect';
import { awaitAbort, withHttpCleanup } from './http-effects.js';
import { AgentInvocationError } from '../../errors.js';
import type { MaterializedHttpRequest } from './request-template.js';

// Runtime-reported DNS/connect failures precede dispatch. Opaque or reset errors do not.
const PRE_DISPATCH_CODES: ReadonlySet<unknown> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_INVALID_URL',
  'ConnectionRefused',
  'FailedToOpenSocket',
]);

/** Accepts only explicit connection codes from the foreign error or its direct cause. */
const failedBeforeDispatch = (error: Error): boolean => {
  return [error, error.cause].some(
    (candidate) =>
      candidate instanceof Error && 'code' in candidate && PRE_DISPATCH_CODES.has(candidate.code),
  );
};

/** The host validates DNS and tenant endpoint policy on every request. */
type GuardedHttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Local release evidence may update after the bounded native owner has returned. */
type HeaderReceipt = {
  headers: 'pending' | 'received' | 'rejected';
  cleanup: 'pending' | 'released' | 'failed';
  failure?: unknown;
};

/** Acquires foreign fetch headers; the caller owns release through the complete body lifetime. */
const openGuardedResponse = Effect.fn('http.guardedHeaders')(function* (
  guardedFetch: GuardedHttpFetch,
  request: MaterializedHttpRequest,
  signal: AbortSignal,
  firstByteMs: number,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });

      if (signal.aborted) abort();

      let releaseHeaders = (): void => {};

      const release = (): void => {
        releaseHeaders();
        signal.removeEventListener('abort', abort);
        controller.abort();
      };

      // This receipt outlives the bounded observer. Foreign callbacks only release a single
      // late body and update diagnostics; they never execute an Effect runtime.
      const receipt: HeaderReceipt = { headers: 'pending', cleanup: 'pending' };
      let observing = true;
      let response: Response | undefined;
      let cancelling = false;
      let cleanupResume: (() => void) | undefined;

      const cancelLateBody = (late: Response): void => {
        if (cancelling) return;
        cancelling = true;

        try {
          const cancelled = late.body?.cancel();

          if (cancelled === undefined) {
            receipt.cleanup = 'released';
            cleanupResume?.();
          } else {
            cancelled.then(
              () => {
                receipt.cleanup = 'released';
                cleanupResume?.();
              },
              (cause: unknown) => {
                receipt.cleanup = 'failed';
                receipt.failure = cause;
                cleanupResume?.();
              },
            );
          }
        } catch (failure) {
          receipt.cleanup = 'failed';
          receipt.failure = failure;
          cleanupResume?.();
        }
      };

      // Only rejected foreign calls become transport errors. A synchronous host defect stays a defect.
      const headers = Effect.callback<Response, AgentInvocationError>((resume, fiberSignal) => {
        const interrupt = (): void => controller.abort(fiberSignal.reason);
        releaseHeaders = (): void => {
          observing = false;
          fiberSignal.removeEventListener('abort', interrupt);
        };

        fiberSignal.addEventListener('abort', interrupt, { once: true });

        const pending = guardedFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual',
          signal: controller.signal,
        });

        pending.then(
          (value) => {
            receipt.headers = 'received';
            response = value;

            if (observing) resume(Effect.succeed(value));
            else cancelLateBody(value);
          },
          (cause: unknown) => {
            receipt.headers = 'rejected';
            receipt.cleanup = 'released';
            cleanupResume?.();

            // Fetch rejection alone does not prove that no request reached the peer.
            const preDispatch = cause instanceof Error && failedBeforeDispatch(cause);

            resume(
              Effect.fail(
                new AgentInvocationError('network', 'HTTP transport failed.', {
                  cause: { primary: cause, receipt },
                  applicationStarted: !preDispatch,
                }),
              ),
            );
          },
        );

        return Effect.sync(releaseHeaders);
      });

      // Headers are an observation. No evidence-producing attempt is raced or timed out.
      const opened = yield* Effect.exit(
        restore(
          Effect.raceFirst(
            headers,
            awaitAbort(signal).pipe(
              Effect.andThen(() =>
                Effect.fail(
                  new AgentInvocationError('timeout', 'HTTP headers were interrupted.', {
                    applicationStarted: true,
                    cause: { receipt },
                  }),
                ),
              ),
            ),
          ).pipe(
            Effect.timeoutOrElse({
              duration: firstByteMs,
              orElse: () =>
                Effect.fail(
                  new AgentInvocationError('timeout', 'HTTP first byte timed out.', {
                    applicationStarted: true,
                    cause: { receipt },
                  }),
                ),
            }),
          ),
        ),
      );

      if (opened._tag === 'Failure') {
        return yield* withHttpCleanup(Effect.failCause(opened.cause), [
          Effect.sync(release),
          Effect.callback<void, AgentInvocationError>((resume) => {
            const finished = (): void =>
              resume(
                receipt.cleanup === 'failed'
                  ? Effect.fail(
                      new AgentInvocationError('network', 'Late HTTP body release failed.', {
                        cause: { receipt },
                        applicationStarted: true,
                      }),
                    )
                  : Effect.void,
              );

            cleanupResume = finished;

            if (response !== undefined) cancelLateBody(response);

            if (receipt.cleanup !== 'pending') finished();

            return Effect.sync(() => {
              cleanupResume = undefined;
            });
          }).pipe(
            Effect.interruptible,
            Effect.timeoutOrElse({
              duration: 100,
              orElse: () =>
                Effect.fail(
                  new AgentInvocationError('network', 'Late HTTP cleanup remains unconfirmed.', {
                    applicationStarted: true,
                    cause: { receipt },
                  }),
                ),
            }),
          ),
        ]);
      }

      return { response: opened.value, controller, release };
    }),
  );
});

export { openGuardedResponse, type GuardedHttpFetch };
