import { createHash } from 'node:crypto';

import { parseAgentResponse, type AgentRequest } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import {
  materializeHttpRequest,
  type ResolvedHttpRequestTemplate,
} from '../http/request-template.js';
import { redactTransportText } from '../http/redaction.js';
import { streamOnce } from './stream-transport.js';
import type { StreamAgentResource, StreamFailure, StreamInvokeOptions } from './types.js';

const DEFAULT_ATTEMPT_MS = 60_000;
const DEFAULT_REQUEST_BYTES = 10 * 1024 * 1024;

const retryDelay = (agent: StreamAgentResource, retryIndex: number): number => {
  const backoff = agent.retry?.backoff;
  if (backoff === undefined || backoff.kind === 'none') return 0;
  if (backoff.kind === 'fixed') return backoff.delay_ms;
  const bounded = Math.min(backoff.initial_delay_ms * 2 ** retryIndex, backoff.maximum_delay_ms);
  const jitter = createHash('sha256')
    .update(`${String(backoff.jitter_seed)}:${String(retryIndex)}`)
    .digest()
    .readUInt32BE(0);
  return Math.floor((bounded * (75 + (jitter % 51))) / 100);
};

const wait = async (
  delayMs: number,
  signal: AbortSignal | undefined,
  callerSignal?: AbortSignal,
): Promise<void> => {
  if (delayMs <= 0) return;
  if (signal === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  const retrySignal = signal;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      retrySignal.removeEventListener('abort', abort);
      reject(
        new AgentInvocationError(
          callerSignal?.aborted === true ? 'cancelled' : 'timeout',
          'Streaming retry wait was interrupted.',
        ),
      );
    };
    function finish(): void {
      retrySignal.removeEventListener('abort', abort);
      resolve();
    }
    retrySignal.addEventListener('abort', abort, { once: true });
    if (retrySignal.aborted) abort();
  });
};

/** Invokes one external SSE or JSONL agent with bounded evidence and pre-event retries only. */
const invokeStreamingAgent = async (
  agent: StreamAgentResource,
  request: AgentRequest,
  options: StreamInvokeOptions = {},
): Promise<InvocationResult> => {
  const overallDeadline =
    agent.timeouts?.run_ms === undefined ? undefined : Date.now() + agent.timeouts.run_ms;
  const overallTimeout =
    agent.timeouts?.run_ms === undefined ? undefined : AbortSignal.timeout(agent.timeouts.run_ms);
  const overallSignal =
    options.signal === undefined
      ? overallTimeout
      : overallTimeout === undefined
        ? options.signal
        : AbortSignal.any([options.signal, overallTimeout]);
  const template: ResolvedHttpRequestTemplate = {
    ...agent.transport.request,
    headers: {
      ...(agent.transport.request.headers as Record<string, string> | undefined),
      ...options.headers,
    },
    query: {
      ...(agent.transport.request.query as Record<string, string> | undefined),
      ...options.query,
    },
  };
  const attempts: InvocationAttempt[] = [];
  for (let retry = 0; ; retry += 1) {
    const attemptTimeout = AbortSignal.timeout(agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS);
    const attemptSignal =
      overallSignal === undefined
        ? attemptTimeout
        : AbortSignal.any([overallSignal, attemptTimeout]);
    const duration = startTimer();
    try {
      const materialized = materializeHttpRequest(
        template,
        request,
        agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
      );
      const completed = await streamOnce(agent, request, materialized, attemptSignal, options);
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
      return { ...attempt, attempts: [...attempts, attempt] };
    } catch (error: unknown) {
      const normalized = (
        error instanceof AgentInvocationError
          ? error
          : new AgentInvocationError('network', 'Streaming transport failed.', { cause: error })
      ) as StreamFailure;
      const attempt: InvocationAttempt = {
        status: 'invocation_error',
        error: normalized,
        diagnostics: {
          ...(normalized.httpStatus === undefined ? {} : { httpStatus: normalized.httpStatus }),
        },
        durationMs: duration(),
        ...(normalized.rawExcerpt === undefined ? {} : { rawExcerpt: normalized.rawExcerpt }),
        warnings: [],
      };
      const retryableStatus =
        normalized.httpStatus === 408 ||
        (normalized.httpStatus === 429 && normalized.retryAfterMs !== undefined) ||
        (normalized.httpStatus ?? 0) >= 500;
      const retryable =
        normalized.code === 'network' || normalized.code === 'timeout' || retryableStatus;
      if (
        retry >= (agent.retry?.retries ?? 0) ||
        !retryable ||
        normalized.applicationStarted === true ||
        normalized.code === 'cancelled'
      ) {
        return { ...attempt, attempts: [...attempts, attempt] };
      }
      attempts.push(attempt);
      try {
        const remainingOverall =
          overallDeadline === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, overallDeadline - Date.now());
        const authoredDelay = retryDelay(agent, retry);
        const delay =
          normalized.httpStatus === 429 && normalized.retryAfterMs !== undefined
            ? Math.min(
                normalized.retryAfterMs,
                agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS,
                remainingOverall,
              )
            : Math.min(authoredDelay, remainingOverall);
        await wait(delay, overallSignal, options.signal);
      } catch (waitError: unknown) {
        const terminal = waitError instanceof AgentInvocationError ? waitError : normalized;
        const failed: InvocationAttempt = { ...attempt, error: terminal };
        return { ...failed, attempts: [...attempts, failed] };
      }
    }
  }
};

export { invokeStreamingAgent, type StreamAgentResource, type StreamInvokeOptions };
