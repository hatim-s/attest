import type { AgentCallback } from '@attest/contracts';
import { Cause, Effect, Exit } from 'effect';
import { RunnerIoError } from './runner-errors.js';

const RETRY_DELAYS_MS = [0, 250, 1_000] as const;

type LateDeliveryCleanup = { cleanupConfirmed?: boolean };

type DeliveryOutcome = {
  delivered: boolean;
  reason: string;
  uncertain: boolean;
  cleanup: readonly Cause.Cause<unknown>[];
  late: LateDeliveryCleanup;
};

/** Retries confirmed 5xx only. An opaque failure cannot prove that delivery was rejected. */
const deliverCompletion = (
  fetchImpl: typeof fetch,
  callback: AgentCallback,
  body: string,
  stopRetrying: AbortSignal,
): Effect.Effect<DeliveryOutcome> =>
  Effect.gen(function* () {
    let reason = '';
    const cleanup: Cause.Cause<unknown>[] = [];
    const late: LateDeliveryCleanup = {};

    for (const delay of RETRY_DELAYS_MS) {
      if (delay > 0) {
        if (stopRetrying.aborted) break;
        yield* Effect.sleep(delay);

        if (stopRetrying.aborted) break;
      }

      const attempt = yield* Effect.exit(
        Effect.tryPromise({
          try: (signal) =>
            fetchImpl(callback.url, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${callback.token}`,
                'content-type': 'application/json',
              },
              body,
              signal,
            }).then((response) => {
              if (signal.aborted) {
                late.cleanupConfirmed = false;
                void (response.body?.cancel() ?? Promise.resolve()).then(
                  () => {
                    late.cleanupConfirmed = true;
                  },
                  (cause) => {
                    cleanup.push(
                      Cause.fail(new RunnerIoError({ operation: 'discard_completion', cause })),
                    );
                  },
                );
              }

              return response;
            }),
          catch: (cause) => new RunnerIoError({ operation: 'post_completion', cause }),
        }).pipe(Effect.timeout(30_000)),
      );

      if (Exit.isFailure(attempt)) {
        cleanup.push(attempt.cause);

        return {
          delivered: false,
          reason: 'Completion delivery unconfirmed.',
          uncertain: true,
          cleanup,
          late,
        };
      }

      const response = attempt.value;

      const discarded = yield* Effect.exit(
        Effect.tryPromise({
          try: () => response.body?.cancel() ?? Promise.resolve(),
          catch: (cause) => new RunnerIoError({ operation: 'discard_completion', cause }),
        }).pipe(Effect.timeout(1_000)),
      );

      if (Exit.isFailure(discarded)) cleanup.push(discarded.cause);

      if (response.ok) return { delivered: true, reason: '', uncertain: false, cleanup, late };
      reason = `receiver answered ${String(response.status)}`;

      if (response.status < 500 || cleanup.length > 0)
        return { delivered: false, reason, uncertain: false, cleanup, late };
    }

    return { delivered: false, reason, uncertain: false, cleanup, late };
  });

export { deliverCompletion, type DeliveryOutcome };
