import { createHash } from 'node:crypto';

import type { AgentResponseCandidate } from '../../internal/agent-response-candidate.js';
import {
  AGENT_PROTOCOL,
  isNumber,
  isString,
  type AgentRequest,
  type JsonValue,
} from '@attest/contracts';

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

/**
 * How a direct or polling exchange ended, with the timing of its last request. A failure carries
 * that request's duration because the invocation may have spanned several requests.
 */
type ExchangeOutcome =
  | { ok: true; durationMs: number; remoteJobId?: string | number; response: HttpJsonResponse }
  | { ok: false; durationMs: number; error: AgentInvocationError };

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

const attemptFromError = (error: AgentInvocationError, durationMs: number): InvocationAttempt =>
  createFailedAttempt(error, {
    diagnostics: error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus },
    durationMs,
    rawExcerpt: error.rawExcerpt,
  });

/** Classifies an unexpected throw; `transport` names the adapter in the message. */
const normalizeFailure = (
  cause: unknown,
  context: {
    transport: 'Mapped HTTP' | 'Callback agent';
    signal: AbortSignal;
    callerSignal: AbortSignal | undefined;
  },
): AgentInvocationError => {
  if (cause instanceof AgentInvocationError) return cause;

  if (context.callerSignal?.aborted === true || context.signal.aborted) {
    return abortedError(context.callerSignal, `${context.transport} invocation`, { cause });
  }

  return new AgentInvocationError('network', `${context.transport} transport failed.`, { cause });
};

const statusError = (response: HttpJsonResponse): AgentInvocationError =>
  new AgentInvocationError('http_status', `Mapped HTTP returned status ${response.status}.`, {
    httpStatus: response.status,
    rawExcerpt: response.rawExcerpt,
  });

type RetryRules = {
  /** Whether a retryable failure may be retried at all; submits need an idempotency key. */
  allowRetry: boolean;
  /** Delay before retry `retry`, given the failed response's Retry-After header if any. */
  delayFor: (retry: number, retryAfter: string | undefined) => number;
};

/** A failed try and what the retry rules need to decide whether to replay it. */
type RequestFailure = { error: AgentInvocationError; retryable: boolean; retryAfter?: string };

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

/**
 * Sends one request until it succeeds, retrying transient transport failures and retryable
 * statuses within the authored budget. Failed tries are kept as attempts on the context.
 */
const requestWithRetries = async (
  request: MaterializedHttpRequest,
  context: ExchangeContext,
  rules: RetryRules,
): Promise<ExchangeOutcome> => {
  const { policy, retryAttempts, signal } = context;
  const retries = context.retry?.retries ?? 0;

  for (let retry = 0; ; retry += 1) {
    const attemptDuration = startTimer();
    let failure: RequestFailure;

    try {
      const transport = context.requestJson ?? (await import('./http-client.js')).requestJson;
      const response = await transport(request, policy);

      if (isSuccessStatus(response.status)) {
        return { ok: true, durationMs: attemptDuration(), response };
      }

      failure = {
        error: statusError(response),
        retryable: retryableStatus(response.status),
        retryAfter: response.headers['retry-after'],
      };
    } catch (error: unknown) {
      const normalized = normalizeFailure(error, {
        transport: 'Mapped HTTP',
        signal,
        callerSignal: policy.callerSignal,
      });

      failure = { error: normalized, retryable: retryableTransportError(normalized) };
    }

    const durationMs = attemptDuration();

    if (!rules.allowRetry || retry >= retries || !failure.retryable) {
      return { ok: false, durationMs, error: failure.error };
    }

    retryAttempts.push(attemptFromError(failure.error, durationMs));
    await abortableWait(rules.delayFor(retry, failure.retryAfter), signal, () =>
      abortedError(policy.callerSignal, 'Mapped HTTP invocation'),
    );
  }
};

/**
 * Adds the idempotency key a server uses to drop a replayed submission. The key is derived from
 * the run and case ids, so every retry of one case sends the same value.
 */
const setIdempotencyHeader = (
  headers: Record<string, string>,
  headerName: string,
  request: AgentRequest,
): void => {
  const duplicate = Object.keys(headers).some(
    (name) => name.toLowerCase() === headerName.toLowerCase(),
  );

  if (duplicate) {
    throw new AgentInvocationError('invalid_envelope', 'Idempotency header mapping is ambiguous.');
  }

  headers[headerName] = createHash('sha256')
    .update(`${request.run_id}:${request.case_id}`)
    .digest('hex');
};

/** Sends a direct request, honoring Retry-After before the authored backoff. */
const runDirect = (
  materialized: MaterializedHttpRequest,
  context: ExchangeContext,
): Promise<ExchangeOutcome> =>
  requestWithRetries(materialized, context, {
    allowRetry: true,
    delayFor: (retry, retryAfter) =>
      parseRetryAfter(retryAfter) ?? retryBackoffDelay(context.retry?.backoff, retry),
  });

export {
  REMOTE_ERROR_FALLBACK,
  attemptFromError,
  extractAgentResponse,
  extractRemoteJobId,
  normalizeFailure,
  requestWithRetries,
  runDirect,
  setIdempotencyHeader,
  type ExchangeContext,
  type ExchangeOutcome,
};
