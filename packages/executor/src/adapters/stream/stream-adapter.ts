import { parseAgentResponse, type AgentRequest, type AgentResource } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import { DEFAULT_ATTEMPT_MS, DEFAULT_REQUEST_BYTES } from '../../internal/agent-defaults.js';
import { startTimer } from '../../internal/elapsed.js';
import { createFailedAttempt } from '../../internal/failed-attempt.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { materializeHttpRequest, resolveRequestTemplate } from '../http/request-template.js';
import { redactTransportText } from '../http/redaction.js';
import { streamOnce, type StreamHttpTransport } from './stream-transport.js';

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

/** Invokes one external SSE or JSONL agent with bounded evidence and pre-event retries only. */
const invokeStreamingAgent = async (
  agent: StreamAgentResource,
  request: AgentRequest,
  options: StreamInvokeOptions = {},
): Promise<InvocationResult> => {
  const runMs = agent.timeouts?.run_ms;
  const attemptMs = agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS;
  const overallDeadline = runMs === undefined ? undefined : Date.now() + runMs;
  const overallSignal = AbortSignal.any(
    [options.signal, runMs === undefined ? undefined : AbortSignal.timeout(runMs)].filter(
      (signal) => signal !== undefined,
    ),
  );
  const attempts: InvocationAttempt[] = [];
  const conclude = (attempt: InvocationAttempt): InvocationResult => ({
    ...attempt,
    attempts: [...attempts, attempt],
  });
  for (let retry = 0; ; retry += 1) {
    const attemptSignal = AbortSignal.any([overallSignal, AbortSignal.timeout(attemptMs)]);
    const duration = startTimer();
    try {
      const materialized = materializeHttpRequest(
        resolveRequestTemplate(agent.transport.request, options),
        request,
        agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
      );
      const completed = await streamOnce(agent, materialized, attemptSignal, options);
      const report = parseAgentResponse(completed.response);
      if (!report.ok)
        throw new AgentInvocationError(
          'invalid_envelope',
          'Streaming extraction is not a valid native response.',
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
      return conclude(attempt);
    } catch (error: unknown) {
      const normalized =
        error instanceof AgentInvocationError
          ? error
          : attemptSignal.aborted
            ? abortedError(options.signal, 'Streaming invocation', { cause: error })
            : new AgentInvocationError('network', 'Streaming transport failed.', { cause: error });
      const evidence = {
        diagnostics:
          normalized.httpStatus === undefined ? {} : { httpStatus: normalized.httpStatus },
        durationMs: duration(),
        rawExcerpt: normalized.rawExcerpt,
      };
      const attempt = createFailedAttempt(normalized, evidence);
      const boundedRetryAfter = normalized.httpStatus === 429 ? normalized.retryAfterMs : undefined;
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
      try {
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
          await abortableWait(delay, overallSignal, () =>
            abortedError(options.signal, 'Streaming retry wait'),
          );
        }
      } catch (waitError: unknown) {
        const terminal = waitError instanceof AgentInvocationError ? waitError : normalized;
        return conclude(createFailedAttempt(terminal, evidence));
      }
    }
  }
};

export { invokeStreamingAgent, type StreamAgentResource, type StreamInvokeOptions };
