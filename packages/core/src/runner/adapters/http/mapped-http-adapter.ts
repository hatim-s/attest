import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  AGENT_PROTOCOL,
  parseAgentResponse,
  type AgentErrorResponse,
  type AgentRequest,
  type AgentResource,
  type AgentResponse,
  type JsonValue,
} from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { requestJson, type HttpJsonResponse } from './http-client.js';
import { readJsonPointer } from './json-pointer.js';
import {
  materializeHttpRequest,
  type MaterializedHttpRequest,
  type ResolvedHttpRequestTemplate,
} from './request-template.js';
import { requireSameOrigin } from './url-security.js';

type HttpAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'http' | 'polling' }>;
};

type MappedHttpInvokeOptions = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

const DEFAULT_ATTEMPT_MS = 60_000;
const DEFAULT_CONNECT_MS = 10_000;
const DEFAULT_FIRST_BYTE_MS = 30_000;
const DEFAULT_BODY_IDLE_MS = 30_000;
const DEFAULT_REQUEST_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_RESPONSE_CAP_BYTES = 10 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 30_000;

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
};

const errorFromExtracted = (value: unknown): AgentErrorResponse['error'] => {
  if (typeof value === 'string') return { message: value };
  if (value !== null && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.message === 'string') {
      return {
        message: candidate.message,
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      };
    }
  }
  return { message: 'The mapped HTTP agent reported an error.' };
};

/** Converts a foreign JSON response into the native Attest response envelope. */
const extractAgentResponse = (
  raw: unknown,
  extraction: Extract<HttpAgentResource['transport'], { kind: 'http' }>['extraction'],
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
    return {
      protocol: AGENT_PROTOCOL,
      error: errorFromExtracted(error),
      ...(trace === undefined ? {} : { trace }),
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
    ...(trace === undefined ? {} : { trace }),
  } as AgentResponse;
};

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const retryDelay = (agent: HttpAgentResource, retryIndex: number): number => {
  const backoff = agent.retry?.backoff;
  if (backoff === undefined || backoff.kind === 'none') return 0;
  if (backoff.kind === 'fixed') return backoff.delay_ms;
  const exponential = backoff.initial_delay_ms * 2 ** retryIndex;
  const bounded = Math.min(exponential, backoff.maximum_delay_ms);
  // A deterministic seed avoids run-to-run timing drift while still breaking synchronized retries.
  const digest = createHash('sha256')
    .update(`${String(backoff.jitter_seed)}:${String(retryIndex)}`)
    .digest()
    .readUInt32BE(0);
  return Math.floor((bounded * (75 + (digest % 51))) / 100);
};

const parseRetryAfter = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (/^\d+$/u.test(value.trim()))
    return Math.min(Number(value.trim()) * 1_000, MAX_RETRY_AFTER_MS);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS)
    : undefined;
};

const wait = async (
  delayMs: number,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<void> => {
  if (signal.aborted)
    throw new AgentInvocationError(
      callerSignal?.aborted === true ? 'cancelled' : 'timeout',
      callerSignal?.aborted === true
        ? 'Mapped HTTP invocation was cancelled.'
        : 'Mapped HTTP invocation timed out.',
    );
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(
        new AgentInvocationError(
          callerSignal?.aborted === true ? 'cancelled' : 'timeout',
          callerSignal?.aborted === true
            ? 'Mapped HTTP invocation was cancelled.'
            : 'Mapped HTTP invocation timed out.',
        ),
      );
    };
    function finish(): void {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
};

const attemptFromError = (
  error: AgentInvocationError & {
    httpStatus?: number;
    rawExcerpt?: InvocationAttempt['rawExcerpt'];
  },
  durationMs: number,
): InvocationAttempt => ({
  status: 'invocation_error',
  error,
  diagnostics: { ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) },
  durationMs,
  ...(error.rawExcerpt === undefined ? {} : { rawExcerpt: error.rawExcerpt }),
  warnings: [],
});

const normalizeFailure = (
  error: unknown,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): AgentInvocationError => {
  if (error instanceof AgentInvocationError) {
    return error.code === 'cancelled' && callerSignal?.aborted !== true
      ? new AgentInvocationError('timeout', 'Mapped HTTP invocation timed out.', { cause: error })
      : error;
  }
  return new AgentInvocationError(
    callerSignal?.aborted === true ? 'cancelled' : signal.aborted ? 'timeout' : 'network',
    callerSignal?.aborted === true
      ? 'Mapped HTTP invocation was cancelled.'
      : signal.aborted
        ? 'Mapped HTTP invocation timed out.'
        : 'Mapped HTTP transport failed.',
    { cause: error },
  );
};

const withResolvedValues = (
  template: ResolvedHttpRequestTemplate,
  options: MappedHttpInvokeOptions,
): ResolvedHttpRequestTemplate => ({
  ...template,
  headers: { ...template.headers, ...options.headers },
  query: { ...template.query, ...options.query },
});

const statusError = (
  response: HttpJsonResponse,
): AgentInvocationError & {
  httpStatus: number;
  rawExcerpt: InvocationAttempt['rawExcerpt'];
} =>
  Object.assign(
    new AgentInvocationError('http_status', `Mapped HTTP returned status ${response.status}.`),
    { httpStatus: response.status, rawExcerpt: response.rawExcerpt },
  );

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
): Promise<HttpJsonResponse> => {
  const retries = agent.retry?.retries ?? 0;
  for (let retry = 0; ; retry += 1) {
    try {
      const response = await requestJson(materialized, policy);
      if (response.status >= 200 && response.status < 300) return response;
      if (retry >= retries || !retryableStatus(response.status)) throw statusError(response);
      retryAttempts.push(attemptFromError(statusError(response), 0));
      await wait(
        parseRetryAfter(response.headers['retry-after']) ?? retryDelay(agent, retry),
        signal,
        policy.callerSignal,
      );
    } catch (error: unknown) {
      const normalized = normalizeFailure(error, signal, policy.callerSignal);
      if (
        retry >= retries ||
        normalized.code === 'cancelled' ||
        normalized.code === 'invalid_envelope' ||
        (normalized.code === 'http_status' &&
          !retryableStatus(
            (normalized as typeof normalized & { httpStatus?: number }).httpStatus ?? 0,
          ))
      ) {
        throw normalized;
      }
      retryAttempts.push(attemptFromError(normalized, 0));
      await wait(retryDelay(agent, retry), signal, policy.callerSignal);
    }
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

const runPolling = async (
  agent: HttpAgentResource & {
    transport: Extract<HttpAgentResource['transport'], { kind: 'polling' }>;
  },
  request: AgentRequest,
  submission: MaterializedHttpRequest,
  policy: Parameters<typeof requestJson>[1],
  signal: AbortSignal,
  retryAttempts: InvocationAttempt[],
): Promise<HttpJsonResponse> => {
  const { transport } = agent;
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
  for (let retry = 0; ; retry += 1) {
    try {
      const response = await requestJson(submission, policy);
      if (response.status >= 200 && response.status < 300) {
        submitted = response;
        break;
      }
      if (
        transport.idempotency_header === undefined ||
        retry >= retries ||
        !retryableStatus(response.status)
      ) {
        throw statusError(response);
      }
      retryAttempts.push(attemptFromError(statusError(response), 0));
      await wait(
        boundedPollingDelay(transport, response.headers['retry-after'], retryDelay(agent, retry)),
        signal,
        policy.callerSignal,
      );
    } catch (error: unknown) {
      const normalized = normalizeFailure(error, signal, policy.callerSignal);
      if (
        transport.idempotency_header === undefined ||
        retry >= retries ||
        normalized.code === 'cancelled'
      ) {
        throw normalized;
      }
      retryAttempts.push(attemptFromError(normalized, 0));
      await wait(
        boundedPollingDelay(transport, undefined, retryDelay(agent, retry)),
        signal,
        policy.callerSignal,
      );
    }
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
    for (let retry = 0; ; retry += 1) {
      try {
        polled = await requestJson(pollRequest, policy);
        if (polled.status >= 200 && polled.status < 300) break;
        if (retry >= retries || !retryableStatus(polled.status)) throw statusError(polled);
        retryAttempts.push(attemptFromError(statusError(polled), 0));
        await wait(
          boundedPollingDelay(transport, polled.headers['retry-after'], retryDelay(agent, retry)),
          signal,
          policy.callerSignal,
        );
      } catch (error: unknown) {
        const normalized = normalizeFailure(error, signal, policy.callerSignal);
        if (retry >= retries || normalized.code === 'cancelled') throw normalized;
        retryAttempts.push(attemptFromError(normalized, 0));
        await wait(
          boundedPollingDelay(transport, undefined, retryDelay(agent, retry)),
          signal,
          policy.callerSignal,
        );
      }
    }
    const status = readJsonPointer(polled.raw, transport.status_pointer);
    if (transport.success_values.some((value) => isDeepStrictEqual(value, status))) return polled;
    if (transport.failure_values.some((value) => isDeepStrictEqual(value, status))) return polled;
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

/** Invokes a direct or polling mapped HTTP resource as one bounded Attest attempt. */
const invokeMappedHttpAgent = async (
  agent: HttpAgentResource,
  request: AgentRequest,
  options: MappedHttpInvokeOptions = {},
): Promise<InvocationResult> => {
  const duration = startTimer();
  const timeoutSignal = AbortSignal.timeout(agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  const requestTemplate =
    agent.transport.kind === 'http' ? agent.transport.request : agent.transport.submit;
  const materialized = materializeHttpRequest(
    withResolvedValues(requestTemplate as ResolvedHttpRequestTemplate, options),
    request,
    agent.limits?.request_bytes ?? DEFAULT_REQUEST_CAP_BYTES,
  );
  const policy = {
    attemptSignal: signal,
    callerSignal: options.signal,
    connectTimeoutMs: agent.timeouts?.connect_ms ?? DEFAULT_CONNECT_MS,
    firstByteTimeoutMs: agent.timeouts?.first_byte_ms ?? DEFAULT_FIRST_BYTE_MS,
    responseBodyTimeoutMs: agent.timeouts?.idle_ms ?? DEFAULT_BODY_IDLE_MS,
    responseCapBytes: agent.limits?.response_bytes ?? DEFAULT_RESPONSE_CAP_BYTES,
    secretsPresent: (options.secrets?.length ?? 0) > 0,
  };
  const retryAttempts: InvocationAttempt[] = [];
  try {
    const response =
      agent.transport.kind === 'http'
        ? await runDirect(
            agent as Parameters<typeof runDirect>[0],
            request,
            materialized,
            policy,
            signal,
            retryAttempts,
          )
        : await runPolling(
            agent as Parameters<typeof runPolling>[0],
            request,
            materialized,
            policy,
            signal,
            retryAttempts,
          );
    requireSuccessfulStatus(response);
    const normalized = extractAgentResponse(response.raw, agent.transport.extraction);
    const report = parseAgentResponse(normalized);
    if (!report.ok) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Mapped HTTP extraction is not a valid agent response.',
      );
    }
    const attempt: InvocationAttempt = {
      status: 'ok',
      raw: normalized,
      report,
      diagnostics: { httpStatus: response.status },
      durationMs: duration(),
      rawExcerpt: response.rawExcerpt,
      warnings: report.warnings,
    };
    return { ...attempt, attempts: [...retryAttempts, attempt] };
  } catch (error: unknown) {
    const normalized = normalizeFailure(error, signal, options.signal) as AgentInvocationError & {
      httpStatus?: number;
      rawExcerpt?: InvocationAttempt['rawExcerpt'];
    };
    const attempt = attemptFromError(normalized, duration());
    return { ...attempt, attempts: [...retryAttempts, attempt] };
  }
};

export { invokeMappedHttpAgent, type HttpAgentResource, type MappedHttpInvokeOptions };
