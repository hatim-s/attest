import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import { startTimer } from '../../internal/elapsed.js';
import { createFailedAttempt } from '../../internal/failed-attempt.js';
import { isJsonValue } from '../../internal/json-value.js';
import { extractRemoteError } from '../../internal/remote-error.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt } from '../../types.js';
import { requestJson, type HttpClientPolicy, type HttpJsonResponse } from './http-client.js';
import { readJsonPointer } from './json-pointer.js';
import { assertStaticUrlAuthority, type MaterializedHttpRequest } from './request-template.js';
import { redactTransportText } from './redaction.js';
import { parseRetryAfter } from './retry-after.js';
import { requireSameOrigin } from './url-security.js';
import type { HttpAgentResource } from './mapped-http-adapter.js';

/** The successful response that ends a direct or polling exchange, with its request timing. */
type CompletedHttpResponse = {
  durationMs: number;
  remoteJobId?: string | number;
  response: HttpJsonResponse;
};

type PollingTransport = Extract<HttpAgentResource['transport'], { kind: 'polling' }>;

/** Shared state of one mapped exchange: retry budget, deadlines, and retained failed attempts. */
type ExchangeContext = {
  retry: HttpAgentResource['retry'];
  policy: HttpClientPolicy;
  signal: AbortSignal;
  retryAttempts: InvocationAttempt[];
};

const REMOTE_ERROR_FALLBACK = 'The mapped HTTP agent reported an error.';

/** Redacts secret representations from extracted JSON before it becomes persisted evidence. */
const redactExtractedJson = (value: unknown, secrets: readonly string[]): unknown =>
  JSON.parse(redactTransportText(JSON.stringify(value), secrets)) as unknown;

/** Extracts an optional provider correlation id without accepting structured secret-bearing data. */
const extractRemoteJobId = (
  raw: unknown,
  pointer: string | undefined,
): string | number | undefined => {
  const value = readJsonPointer(raw, pointer);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
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
  raw: unknown,
  extraction: HttpAgentResource['transport']['extraction'],
  secrets: readonly string[],
): Record<string, unknown> => {
  const error = readJsonPointer(raw, extraction.error_pointer);
  const trace = readJsonPointer(raw, extraction.trace_pointer);
  if (error !== undefined && error !== null) {
    const extractedError = extractRemoteError(error, REMOTE_ERROR_FALLBACK);
    return {
      protocol: AGENT_PROTOCOL,
      error: {
        ...extractedError,
        message: redactTransportText(extractedError.message, secrets),
        ...(extractedError.code === undefined
          ? {}
          : { code: redactTransportText(extractedError.code, secrets) }),
      },
      ...(trace === undefined ? {} : { trace: redactExtractedJson(trace, secrets) }),
    };
  }
  const result = readJsonPointer(raw, extraction.result_pointer);
  if (result === undefined || !isJsonValue(result)) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Mapped HTTP result extraction did not produce a JSON value.',
    );
  }
  return {
    protocol: AGENT_PROTOCOL,
    output: result,
    ...(trace === undefined ? {} : { trace: redactExtractedJson(trace, secrets) }),
  };
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
  error: unknown,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): AgentInvocationError => {
  if (error instanceof AgentInvocationError) {
    if (error.code !== 'cancelled' || callerSignal?.aborted === true) return error;
    return new AgentInvocationError('timeout', 'Mapped HTTP invocation timed out.', {
      cause: error,
    });
  }
  if (callerSignal?.aborted === true || signal.aborted) {
    return abortedError(callerSignal, 'Mapped HTTP invocation', { cause: error });
  }
  return new AgentInvocationError('network', 'Mapped HTTP transport failed.', { cause: error });
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

/** Sends a direct request, retrying transient transport failures and retryable statuses. */
const runDirect = async (
  materialized: MaterializedHttpRequest,
  context: ExchangeContext,
): Promise<CompletedHttpResponse> => {
  const { policy, retry: retryPolicy, retryAttempts, signal } = context;
  const retries = retryPolicy?.retries ?? 0;
  for (let retry = 0; ; retry += 1) {
    const attemptDuration = startTimer();
    let response: HttpJsonResponse;
    try {
      response = await requestJson(materialized, policy);
    } catch (error: unknown) {
      const durationMs = attemptDuration();
      const normalized = normalizeFailure(error, signal, policy.callerSignal);
      if (
        retry >= retries ||
        normalized.code === 'cancelled' ||
        !retryableTransportError(normalized)
      ) {
        throw withAttemptDuration(normalized, durationMs);
      }
      retryAttempts.push(attemptFromError(normalized, durationMs));
      await wait(retryDelay(retryPolicy, retry), signal, policy.callerSignal);
      continue;
    }
    const durationMs = attemptDuration();
    if (response.status >= 200 && response.status < 300) return { durationMs, response };
    const error = statusError(response);
    if (retry >= retries || !retryableStatus(response.status)) {
      throw withAttemptDuration(error, durationMs);
    }
    retryAttempts.push(attemptFromError(error, durationMs));
    await wait(
      parseRetryAfter(response.headers['retry-after']) ?? retryDelay(retryPolicy, retry),
      signal,
      policy.callerSignal,
    );
  }
};

/** Renders the status URL from the submit response or the authored template. */
const renderStatusUrl = (
  transport: PollingTransport,
  response: HttpJsonResponse,
  jobId: string | number,
): string => {
  const extracted = readJsonPointer(response.raw, transport.status_url_pointer);
  if (typeof extracted === 'string') return extracted;
  if (extracted !== undefined) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Polling status URL extraction must be a string.',
    );
  }
  const template = transport.status_url_template;
  if (template === undefined) {
    throw new AgentInvocationError('invalid_envelope', 'Polling requires a status URL.');
  }
  return template.replaceAll('{{job_id}}', encodeURIComponent(String(jobId)));
};

const pollingUrl = (
  transport: PollingTransport,
  response: HttpJsonResponse,
  jobId: string | number,
): URL => {
  const rendered = renderStatusUrl(transport, response, jobId);
  if (rendered.includes('{{')) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Polling status URL has an unresolved placeholder.',
    );
  }
  const candidate = new URL(rendered, response.url);
  requireSameOrigin(candidate, response.url);
  return candidate;
};

/** Keeps a polling or retry delay inside the authored polling interval bounds. */
const clampInterval = (transport: PollingTransport, delayMs: number): number =>
  Math.min(Math.max(delayMs, transport.minimum_interval_ms), transport.maximum_interval_ms);

const boundedPollingDelay = (
  transport: PollingTransport,
  retryAfter: string | undefined,
  fallback: number,
): number => clampInterval(transport, parseRetryAfter(retryAfter) ?? fallback);

/** Validates every polling invariant before a submission can create remote work. */
const assertPollingConfiguration = (transport: PollingTransport): void => {
  if (
    (transport.status_url_pointer === undefined) ===
    (transport.status_url_template === undefined)
  ) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Polling requires exactly one status URL pointer or template.',
    );
  }
  if (transport.minimum_interval_ms > transport.maximum_interval_ms) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Polling maximum interval must be at least its minimum interval.',
    );
  }
  if (
    transport.success_values.some((success) =>
      transport.failure_values.some((failure) => isDeepStrictEqual(success, failure)),
    )
  ) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Polling success and failure terminal values must not overlap.',
    );
  }
  if (transport.status_url_template !== undefined) {
    assertStaticUrlAuthority(transport.status_url_template);
    const rendered = transport.status_url_template.replaceAll('{{job_id}}', 'job');
    if (rendered.includes('{{')) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Polling status URL template contains an unsupported placeholder.',
      );
    }
    let submit: URL;
    let status: URL;
    try {
      submit = new URL(transport.submit.url);
      status = new URL(rendered, submit);
    } catch (error: unknown) {
      throw new AgentInvocationError('invalid_envelope', 'Polling status URL is invalid.', {
        cause: error,
      });
    }
    requireSameOrigin(status, submit);
  }
};

/** Converts an authored polling failure state into a failed probe with bounded response evidence. */
const pollingFailure = (
  transport: PollingTransport,
  response: HttpJsonResponse,
  secrets: readonly string[],
): AgentInvocationError => {
  const extracted = readJsonPointer(response.raw, transport.extraction.error_pointer);
  return new AgentInvocationError(
    'invalid_envelope',
    extracted === undefined || extracted === null
      ? 'Mapped HTTP polling reached a configured failure state.'
      : redactTransportText(extractRemoteError(extracted, REMOTE_ERROR_FALLBACK).message, secrets),
    { rawExcerpt: response.rawExcerpt },
  );
};

/** Submits remote work, then polls its status URL until an authored terminal value appears. */
const runPolling = async (
  transport: PollingTransport,
  request: AgentRequest,
  submission: MaterializedHttpRequest,
  context: ExchangeContext,
): Promise<CompletedHttpResponse> => {
  const { policy, retry: retryPolicy, retryAttempts, signal } = context;
  assertPollingConfiguration(transport);
  const retries = retryPolicy?.retries ?? 0;
  const idempotencyHeader = transport.idempotency_header;
  if (idempotencyHeader !== undefined) {
    const duplicate = Object.keys(submission.headers).find(
      (name) => name.toLowerCase() === idempotencyHeader.toLowerCase(),
    );
    if (duplicate !== undefined) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Idempotency header mapping is ambiguous.',
      );
    }
    submission.headers[idempotencyHeader] = createHash('sha256')
      .update(`${request.run_id}:${request.case_id}`)
      .digest('hex');
  }

  let submitted: HttpJsonResponse | undefined;
  let submittedDurationMs = 0;
  for (let retry = 0; ; retry += 1) {
    const attemptDuration = startTimer();
    let response: HttpJsonResponse;
    try {
      response = await requestJson(submission, policy);
    } catch (error: unknown) {
      const durationMs = attemptDuration();
      const normalized = normalizeFailure(error, signal, policy.callerSignal);
      if (
        transport.idempotency_header === undefined ||
        retry >= retries ||
        !retryableTransportError(normalized)
      ) {
        throw withAttemptDuration(normalized, durationMs);
      }
      retryAttempts.push(attemptFromError(normalized, durationMs));
      await wait(
        boundedPollingDelay(transport, undefined, retryDelay(retryPolicy, retry)),
        signal,
        policy.callerSignal,
      );
      continue;
    }
    const durationMs = attemptDuration();
    if (response.status >= 200 && response.status < 300) {
      submitted = response;
      submittedDurationMs = durationMs;
      break;
    }
    const error = statusError(response);
    if (
      transport.idempotency_header === undefined ||
      retry >= retries ||
      !retryableStatus(response.status)
    ) {
      throw withAttemptDuration(error, durationMs);
    }
    retryAttempts.push(attemptFromError(error, durationMs));
    await wait(
      boundedPollingDelay(
        transport,
        response.headers['retry-after'],
        retryDelay(retryPolicy, retry),
      ),
      signal,
      policy.callerSignal,
    );
  }

  const jobId = readJsonPointer(submitted.raw, transport.job_id_pointer);
  if (typeof jobId !== 'string' && typeof jobId !== 'number') {
    throw new AgentInvocationError('invalid_envelope', 'Polling job id extraction failed.');
  }
  const statusUrl = pollingUrl(transport, submitted, jobId);
  const pollRequest: MaterializedHttpRequest = {
    method: 'GET',
    url: statusUrl.toString(),
    headers: Object.fromEntries(
      Object.entries(submission.headers).filter(
        ([name]) =>
          !['content-length', 'content-type', transport.idempotency_header?.toLowerCase()].includes(
            name.toLowerCase(),
          ),
      ),
    ),
  };

  let interval = transport.minimum_interval_ms;
  for (;;) {
    await wait(interval, signal, policy.callerSignal);
    let polled: HttpJsonResponse;
    let polledDurationMs = submittedDurationMs;
    for (let retry = 0; ; retry += 1) {
      const attemptDuration = startTimer();
      let response: HttpJsonResponse;
      try {
        response = await requestJson(pollRequest, policy);
      } catch (error: unknown) {
        const durationMs = attemptDuration();
        const normalized = normalizeFailure(error, signal, policy.callerSignal);
        if (retry >= retries || !retryableTransportError(normalized)) {
          throw withAttemptDuration(normalized, durationMs);
        }
        retryAttempts.push(attemptFromError(normalized, durationMs));
        await wait(
          boundedPollingDelay(transport, undefined, retryDelay(retryPolicy, retry)),
          signal,
          policy.callerSignal,
        );
        continue;
      }
      const durationMs = attemptDuration();
      if (response.status >= 200 && response.status < 300) {
        polled = response;
        polledDurationMs = durationMs;
        break;
      }
      const error = statusError(response);
      if (retry >= retries || !retryableStatus(response.status)) {
        throw withAttemptDuration(error, durationMs);
      }
      retryAttempts.push(attemptFromError(error, durationMs));
      await wait(
        boundedPollingDelay(
          transport,
          response.headers['retry-after'],
          retryDelay(retryPolicy, retry),
        ),
        signal,
        policy.callerSignal,
      );
    }
    const status = readJsonPointer(polled.raw, transport.status_pointer);
    if (transport.success_values.some((value) => isDeepStrictEqual(value, status))) {
      return {
        durationMs: polledDurationMs,
        response: polled,
        remoteJobId:
          extractRemoteJobId(polled.raw, transport.extraction.remote_job_id_pointer) ?? jobId,
      };
    }
    if (transport.failure_values.some((value) => isDeepStrictEqual(value, status))) {
      throw withAttemptDuration(
        pollingFailure(transport, polled, policy.secrets),
        polledDurationMs,
      );
    }
    const next = parseRetryAfter(polled.headers['retry-after']) ?? interval * 2;
    interval = clampInterval(transport, next);
  }
};

export {
  attemptFromError,
  extractAgentResponse,
  extractRemoteJobId,
  normalizeFailure,
  requireSuccessfulStatus,
  runDirect,
  runPolling,
};
