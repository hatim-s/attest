import type { AgentResponseCandidate } from '../../internal/agent-response-candidate.js';
import { AGENT_PROTOCOL, isNumber, isString, type JsonValue } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import { startTimer } from '../../internal/elapsed.js';
import { createFailedAttempt } from '../../internal/failed-attempt.js';
import { parseJson } from '../../internal/json-value.js';
import { extractRemoteError } from '../../internal/remote-error.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt } from '../../types.js';
import type { HttpClientPolicy, HttpJsonResponse, HttpJsonTransport } from './http-client.js';
import { readJsonPointer } from './json-pointer.js';
import type { MaterializedHttpRequest } from './request-template.js';
import { redactTransportText } from './redaction.js';
import { parseRetryAfter } from './retry-after.js';
import type { HttpAgentResource } from './mapped-http-adapter.js';

/** The successful response that ends a direct or polling exchange, with its request timing. */
type CompletedHttpResponse = {
  durationMs: number;
  remoteJobId?: string | number;
  response: HttpJsonResponse;
};

/** Shared state of one mapped exchange: retry budget, deadlines, and retained failed attempts. */
type ExchangeContext = {
  retry: HttpAgentResource['retry'];
  policy: HttpClientPolicy;
  signal: AbortSignal;
  retryAttempts: InvocationAttempt[];
  requestJson?: HttpJsonTransport;
};

const REMOTE_ERROR_FALLBACK = 'The mapped HTTP agent reported an error.';

/** Redacts secret representations from extracted JSON before it becomes persisted evidence. */
const redactExtractedJson = (value: JsonValue, secrets: readonly string[]): JsonValue =>
  parseJson(redactTransportText(JSON.stringify(value), secrets));

/** Extracts an optional provider correlation id without accepting structured secret-bearing data. */
const extractRemoteJobId = (
  raw: JsonValue,
  pointer: string | undefined,
): string | number | undefined => {
  const value = readJsonPointer(raw, pointer);

  if (value === undefined || value === null) return undefined;

  if (!isString(value) && !isNumber(value)) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Mapped HTTP remote job id extraction must produce a string or number.',
    );
  }

  return value;
};

/**
 * Maps a foreign JSON response onto a candidate native envelope. The caller validates the
 * candidate with parseAgentResponse, so extraction only has to place values correctly.
 */
const extractAgentResponse = (
  raw: JsonValue,
  extraction: HttpAgentResource['transport']['extraction'],
  secrets: readonly string[],
): AgentResponseCandidate => {
  const error = readJsonPointer(raw, extraction.error_pointer);
  const trace = readJsonPointer(raw, extraction.trace_pointer);

  if (error !== undefined && error !== null) {
    const extractedError = extractRemoteError(error, REMOTE_ERROR_FALLBACK);

    const response: AgentResponseCandidate = {
      protocol: AGENT_PROTOCOL,
      error: { message: redactTransportText(extractedError.message, secrets) },
    };

    if (extractedError.code !== undefined && response.error !== undefined) {
      response.error.code = redactTransportText(extractedError.code, secrets);
    }

    if (trace !== undefined) response.trace = redactExtractedJson(trace, secrets);

    return response;
  }

  const result = readJsonPointer(raw, extraction.result_pointer);

  if (result === undefined) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Mapped HTTP result extraction did not produce a JSON value.',
    );
  }

  const response: AgentResponseCandidate = { protocol: AGENT_PROTOCOL, output: result };

  if (trace !== undefined) response.trace = redactExtractedJson(trace, secrets);

  return response;
};

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const retryableTransportError = (error: AgentInvocationError): boolean =>
  error.code === 'network' || error.code === 'timeout';

const retryDelay = (retry: HttpAgentResource['retry'], retryIndex: number): number =>
  retryBackoffDelay(retry?.backoff, retryIndex);

const wait = (delayMs: number, signal: AbortSignal, callerSignal?: AbortSignal): Promise<void> =>
  abortableWait(delayMs, signal, () => abortedError(callerSignal, 'Mapped HTTP invocation'));

const attemptFromError = (error: AgentInvocationError, durationMs: number): InvocationAttempt =>
  createFailedAttempt(error, {
    diagnostics: error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus },
    durationMs,
    rawExcerpt: error.rawExcerpt,
  });

/** Carries request-local timing through terminal error normalization without exposing it publicly. */
const withAttemptDuration = (
  error: AgentInvocationError,
  durationMs: number,
): AgentInvocationError => {
  error.attemptDurationMs = durationMs;

  return error;
};

const normalizeFailure = (
  cause: unknown,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): AgentInvocationError => {
  if (cause instanceof AgentInvocationError) {
    if (cause.code !== 'cancelled' || callerSignal?.aborted === true) return cause;

    return new AgentInvocationError('timeout', 'Mapped HTTP invocation timed out.', {
      cause: cause,
    });
  }

  if (callerSignal?.aborted === true || signal.aborted) {
    return abortedError(callerSignal, 'Mapped HTTP invocation', { cause: cause });
  }

  return new AgentInvocationError('network', 'Mapped HTTP transport failed.', { cause: cause });
};

const statusError = (response: HttpJsonResponse): AgentInvocationError =>
  new AgentInvocationError('http_status', `Mapped HTTP returned status ${response.status}.`, {
    httpStatus: response.status,
    rawExcerpt: response.rawExcerpt,
  });

const requireSuccessfulStatus = (response: HttpJsonResponse): void => {
  if (response.status >= 200 && response.status < 300) return;
  throw statusError(response);
};

type RetryRules = {
  /** Whether a retryable failure may be retried at all; submits need an idempotency key. */
  allowRetry: boolean;
  /** Delay before retry `retry`, given the failed response's Retry-After header if any. */
  delayFor: (retry: number, retryAfter: string | undefined) => number;
};

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

/**
 * Sends one request until it succeeds, retrying transient transport failures and retryable
 * statuses within the authored budget. Failed tries are kept as attempts on the context.
 */
const requestWithRetries = async (
  request: MaterializedHttpRequest,
  context: ExchangeContext,
  rules: RetryRules,
): Promise<{ durationMs: number; response: HttpJsonResponse }> => {
  const { policy, retryAttempts, signal } = context;
  const retries = context.retry?.retries ?? 0;

  const retryOrThrow = async (
    error: AgentInvocationError,
    durationMs: number,
    retryable: boolean,
    retry: number,
    retryAfter: string | undefined,
  ): Promise<void> => {
    if (!rules.allowRetry || retry >= retries || !retryable) {
      throw withAttemptDuration(error, durationMs);
    }

    retryAttempts.push(attemptFromError(error, durationMs));
    await wait(rules.delayFor(retry, retryAfter), signal, policy.callerSignal);
  };

  for (let retry = 0; ; retry += 1) {
    const attemptDuration = startTimer();
    let response: HttpJsonResponse;

    try {
      const transport = context.requestJson ?? (await import('./http-client.js')).requestJson;
      response = await transport(request, policy);
    } catch (error: unknown) {
      const normalized = normalizeFailure(error, signal, policy.callerSignal);
      const retryable = retryableTransportError(normalized);
      await retryOrThrow(normalized, attemptDuration(), retryable, retry, undefined);
      continue;
    }

    const durationMs = attemptDuration();

    if (isSuccessStatus(response.status)) return { durationMs, response };
    const retryAfter = response.headers['retry-after'];
    await retryOrThrow(
      statusError(response),
      durationMs,
      retryableStatus(response.status),
      retry,
      retryAfter,
    );
  }
};

/** Sends a direct request, honoring Retry-After before the authored backoff. */
const runDirect = (
  materialized: MaterializedHttpRequest,
  context: ExchangeContext,
): Promise<CompletedHttpResponse> =>
  requestWithRetries(materialized, context, {
    allowRetry: true,
    delayFor: (retry, retryAfter) =>
      parseRetryAfter(retryAfter) ?? retryDelay(context.retry, retry),
  });

export {
  REMOTE_ERROR_FALLBACK,
  attemptFromError,
  extractAgentResponse,
  extractRemoteJobId,
  normalizeFailure,
  requestWithRetries,
  requireSuccessfulStatus,
  retryDelay,
  runDirect,
  wait,
  withAttemptDuration,
  type CompletedHttpResponse,
  type ExchangeContext,
};
