import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { AGENT_PROTOCOL, type AgentRequest, type AgentResponse } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import { startTimer } from '../../internal/elapsed.js';
import { isJsonValue } from '../../internal/json-value.js';
import { extractRemoteError } from '../../internal/remote-error.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt } from '../../types.js';
import { requestJson, type HttpJsonResponse } from './http-client.js';
import { readJsonPointer } from './json-pointer.js';
import { assertStaticUrlAuthority, type MaterializedHttpRequest } from './request-template.js';
import { redactTransportText } from './redaction.js';
import { parseRetryAfter } from './retry-after.js';
import { requireSameOrigin } from './url-security.js';
import type { CompletedHttpResponse, HttpAgentResource } from './mapped-http-types.js';

const REMOTE_ERROR_FALLBACK = 'The mapped HTTP agent reported an error.';

/** Redacts secret representations from extracted JSON before it becomes persisted evidence. */
const redactExtractedJson = (value: unknown, secrets: readonly string[]): unknown =>
  JSON.parse(redactTransportText(JSON.stringify(value), secrets)) as unknown;

/** Extracts an optional provider correlation id without accepting structured secret-bearing data. */
const extractRemoteJobId = (
  raw: unknown,
  pointer: string | undefined,
): string | number | undefined => {
  if (pointer === undefined) return undefined;
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

/** Converts a foreign JSON response into the native Attest response envelope. */
const extractAgentResponse = (
  raw: unknown,
  extraction: Extract<HttpAgentResource['transport'], { kind: 'http' }>['extraction'],
  secrets: readonly string[],
): AgentResponse => {
  const error =
    extraction.error_pointer === undefined
      ? undefined
      : readJsonPointer(raw, extraction.error_pointer);
  const trace =
    extraction.trace_pointer === undefined
      ? undefined
      : readJsonPointer(raw, extraction.trace_pointer);
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
    } as AgentResponse;
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
  } as AgentResponse;
};

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const retryableTransportError = (error: AgentInvocationError): boolean =>
  error.code === 'network' || error.code === 'timeout';

const retryDelay = (agent: HttpAgentResource, retryIndex: number): number =>
  retryBackoffDelay(agent.retry?.backoff, retryIndex);

const wait = (delayMs: number, signal: AbortSignal, callerSignal?: AbortSignal): Promise<void> =>
  abortableWait(delayMs, signal, () => abortedError(callerSignal, 'Mapped HTTP invocation'));

const attemptFromError = (error: AgentInvocationError, durationMs: number): InvocationAttempt => ({
  status: 'invocation_error',
  error,
  diagnostics: { ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) },
  durationMs,
  ...(error.rawExcerpt === undefined ? {} : { rawExcerpt: error.rawExcerpt }),
  warnings: [],
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

const runDirect = async (
  agent: HttpAgentResource & {
    transport: Extract<HttpAgentResource['transport'], { kind: 'http' }>;
  },
  request: AgentRequest,
  materialized: MaterializedHttpRequest,
  policy: Parameters<typeof requestJson>[1],
  signal: AbortSignal,
  retryAttempts: InvocationAttempt[],
): Promise<CompletedHttpResponse> => {
  const retries = agent.retry?.retries ?? 0;
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
      await wait(retryDelay(agent, retry), signal, policy.callerSignal);
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
      parseRetryAfter(response.headers['retry-after']) ?? retryDelay(agent, retry),
      signal,
      policy.callerSignal,
    );
  }
};

const pollingUrl = (
  transport: Extract<HttpAgentResource['transport'], { kind: 'polling' }>,
  response: HttpJsonResponse,
  jobId: string | number,
): URL => {
  const extracted =
    transport.status_url_pointer === undefined
      ? undefined
      : readJsonPointer(response.raw, transport.status_url_pointer);
  const template = transport.status_url_template;
  if (extracted === undefined && template === undefined) {
    throw new AgentInvocationError('invalid_envelope', 'Polling requires a status URL.');
  }
  if (extracted !== undefined && typeof extracted !== 'string') {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Polling status URL extraction must be a string.',
    );
  }
  const rendered =
    extracted ?? template!.replaceAll('{{job_id}}', encodeURIComponent(String(jobId)));
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

const boundedPollingDelay = (
  transport: Extract<HttpAgentResource['transport'], { kind: 'polling' }>,
  retryAfter: string | undefined,
  fallback: number,
): number =>
  Math.min(
    Math.max(parseRetryAfter(retryAfter) ?? fallback, transport.minimum_interval_ms),
    transport.maximum_interval_ms,
  );

/** Validates every polling invariant before a submission can create remote work. */
const assertPollingConfiguration = (
  transport: Extract<HttpAgentResource['transport'], { kind: 'polling' }>,
): void => {
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
  transport: Extract<HttpAgentResource['transport'], { kind: 'polling' }>,
  response: HttpJsonResponse,
  secrets: readonly string[],
): AgentInvocationError => {
  const extracted =
    transport.extraction.error_pointer === undefined
      ? undefined
      : readJsonPointer(response.raw, transport.extraction.error_pointer);
  return new AgentInvocationError(
    'invalid_envelope',
    extracted === undefined || extracted === null
      ? 'Mapped HTTP polling reached a configured failure state.'
      : redactTransportText(extractRemoteError(extracted, REMOTE_ERROR_FALLBACK).message, secrets),
    { rawExcerpt: response.rawExcerpt },
  );
};

const runPolling = async (
  agent: HttpAgentResource & {
    transport: Extract<HttpAgentResource['transport'], { kind: 'polling' }>;
  },
  request: AgentRequest,
  submission: MaterializedHttpRequest,
  policy: Parameters<typeof requestJson>[1],
  signal: AbortSignal,
  retryAttempts: InvocationAttempt[],
): Promise<CompletedHttpResponse> => {
  const { transport } = agent;
  assertPollingConfiguration(transport);
  const retries = agent.retry?.retries ?? 0;
  if (transport.idempotency_header !== undefined) {
    const duplicate = Object.keys(submission.headers).find(
      (name) => name.toLowerCase() === transport.idempotency_header!.toLowerCase(),
    );
    if (duplicate !== undefined) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Idempotency header mapping is ambiguous.',
      );
    }
    submission.headers[transport.idempotency_header] = createHash('sha256')
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
        boundedPollingDelay(transport, undefined, retryDelay(agent, retry)),
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
      boundedPollingDelay(transport, response.headers['retry-after'], retryDelay(agent, retry)),
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
          boundedPollingDelay(transport, undefined, retryDelay(agent, retry)),
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
        boundedPollingDelay(transport, response.headers['retry-after'], retryDelay(agent, retry)),
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
    const retryAfter = parseRetryAfter(polled.headers['retry-after']);
    interval =
      retryAfter === undefined
        ? Math.min(
            Math.max(interval * 2, transport.minimum_interval_ms),
            transport.maximum_interval_ms,
          )
        : Math.min(
            Math.max(retryAfter, transport.minimum_interval_ms),
            transport.maximum_interval_ms,
          );
  }
};

export {
  assertPollingConfiguration,
  attemptFromError,
  extractAgentResponse,
  extractRemoteJobId,
  normalizeFailure,
  requireSuccessfulStatus,
  runDirect,
  runPolling,
};
