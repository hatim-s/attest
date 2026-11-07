import * as Effect from 'effect/Effect';
import { httpSync, httpDelay, withHttpSignal } from '../http/http-effects.js';
import { parseAgentResponse, type AgentRequest, type AgentResource } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { DEFAULT_ATTEMPT_MS, DEFAULT_REQUEST_BYTES } from '../../internal/agent-defaults.js';
import { startTimer } from '../../internal/elapsed.js';
import { createFailedAttempt } from '../../internal/failed-attempt.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { materializeHttpRequest, resolveRequestTemplate } from '../http/request-template.js';
import { redactTransportText } from '../http/redaction.js';
import { streamOnce, type StreamHttpTransport } from './stream-transport.js';

/** Retains the invocation result when disposing its outer signal ownership fails. */
class StreamCleanupError extends AgentInvocationError {
  constructor(
    readonly cleanupError: AgentInvocationError,
    readonly result: InvocationResult,
  ) {
    super(cleanupError.code, cleanupError.message, {
      cause: cleanupError.cause,
      applicationStarted: true,
      httpStatus: cleanupError.httpStatus,
      rawExcerpt: cleanupError.rawExcerpt,
    });
  }
}

/** An agent that answers over an SSE or JSONL HTTP stream. */
type StreamAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'stream' }>;
};

/** Runtime-resolved request values and cancellation for one streaming invocation. */
type StreamInvokeOptions = {
  /** Overrides local socket I/O with a host-owned guarded transport. */
  requestStream?: StreamHttpTransport;
  /** Overrides the authored retry budget. Zero forbids replay. */
  retries?: number;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

/** Invokes an SSE or JSONL agent; only failures before successful headers can permit retry. */
const invokeStreamingAgent = Effect.fn('stream.invoke')(function* (
  agent: StreamAgentResource,
  request: AgentRequest,
  options: StreamInvokeOptions = {},
) {
  let completedResult: InvocationResult | undefined;
  const runMs = agent.timeouts?.run_ms;
  const attemptMs = agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS;
  const overallDeadline = runMs === undefined ? undefined : Date.now() + runMs;

  return yield* withHttpSignal(
    runMs ?? Number.POSITIVE_INFINITY,
    [options.signal],
    (overallSignal) =>
      Effect.gen(function* () {
        const attempts: InvocationAttempt[] = [];

        const conclude = (attempt: InvocationAttempt): InvocationResult => ({
          ...attempt,
          attempts: [...attempts, attempt],
        });

        for (let retry = 0; ; retry += 1) {
          const duration = startTimer();
          let completedAttempt: InvocationAttempt | undefined;

          const outcome = yield* Effect.result(
            withHttpSignal(attemptMs, [overallSignal], (attemptSignal) =>
              Effect.gen(function* () {
                const materialized = yield* httpSync(() =>
                  materializeHttpRequest(
                    resolveRequestTemplate(agent.transport.request, options),
                    request,
                    agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
                  ),
                );

                const completed = yield* streamOnce(agent, materialized, attemptSignal, options);
                const report = parseAgentResponse(completed.response);

                if (!report.ok)
                  return yield* Effect.fail(
                    new AgentInvocationError(
                      'invalid_envelope',
                      'Streaming extraction is not a valid native response.',
                    ),
                  );

                const attempt: InvocationAttempt = {
                  status: 'ok',
                  raw: completed.response,
                  report,
                  diagnostics: { httpStatus: completed.status },
                  durationMs: duration(),
                  rawExcerpt: createRawExcerpt(
                    redactTransportText(completed.evidence, options.secrets ?? []),
                  ),
                  warnings: report.warnings,
                };

                completedAttempt = attempt;

                return attempt;
              }),
            ),
          );

          if (outcome._tag === 'Success') return conclude(outcome.success);
          {
            const normalized = outcome.failure;

            const evidence = {
              diagnostics:
                completedAttempt?.diagnostics ??
                (normalized.httpStatus === undefined ? {} : { httpStatus: normalized.httpStatus }),
              durationMs: duration(),
              rawExcerpt: completedAttempt?.rawExcerpt ?? normalized.rawExcerpt,
            };

            const attempt = {
              ...createFailedAttempt(normalized, evidence),
              warnings: completedAttempt?.warnings ?? [],
            };

            const boundedRetryAfter =
              normalized.httpStatus === 429 ? normalized.retryAfterMs : undefined;

            const retryableStatus =
              normalized.httpStatus === 408 ||
              boundedRetryAfter !== undefined ||
              (normalized.httpStatus ?? 0) >= 500;

            const retryable =
              normalized.code === 'network' || normalized.code === 'timeout' || retryableStatus;

            if (
              retry >= (options.retries ?? agent.retry?.retries ?? 0) ||
              !retryable ||
              normalized.applicationStarted === true ||
              normalized.code === 'cancelled'
            ) {
              return conclude(attempt);
            }

            attempts.push(attempt);

            {
              const remainingOverall =
                overallDeadline === undefined
                  ? Number.POSITIVE_INFINITY
                  : Math.max(0, overallDeadline - Date.now());

              // A 429 is retried only on its own Retry-After, bounded by one attempt deadline.
              const requested =
                boundedRetryAfter === undefined
                  ? retryBackoffDelay(agent.retry?.backoff, retry)
                  : Math.min(boundedRetryAfter, attemptMs);

              const delay = Math.min(requested, remainingOverall);

              if (delay > 0) {
                const waited = yield* Effect.result(
                  httpDelay(delay, overallSignal, options.signal),
                );

                if (waited._tag === 'Failure')
                  return conclude(createFailedAttempt(waited.failure, evidence));
              }
            }
          }
        }
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            completedResult = result;
          }),
        ),
      ),
  ).pipe(
    Effect.mapError((error) =>
      completedResult === undefined ? error : new StreamCleanupError(error, completedResult),
    ),
  );
});

export {
  StreamCleanupError,
  invokeStreamingAgent,
  type StreamAgentResource,
  type StreamInvokeOptions,
};
