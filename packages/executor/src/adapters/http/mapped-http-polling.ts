import { isDeepStrictEqual } from 'node:util';

import { isNumber, isString, type AgentRequest } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import { extractRemoteError } from '../../internal/remote-error.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { HttpJsonResponse } from './http-client.js';
import { readJsonPointer } from './json-pointer.js';
import type { HttpAgentResource } from './mapped-http-adapter.js';
import {
  REMOTE_ERROR_FALLBACK,
  extractRemoteJobId,
  requestWithRetries,
  setIdempotencyHeader,
  type ExchangeContext,
  type ExchangeOutcome,
} from './mapped-http-execution.js';
import { assertStaticUrlAuthority, type MaterializedHttpRequest } from './request-template.js';
import { redactTransportText } from './redaction.js';
import { parseRetryAfter } from './retry-after.js';
import { requireSameOrigin } from './same-origin.js';

type PollingTransport = Extract<HttpAgentResource['transport'], { kind: 'polling' }>;

/** Renders the status URL from the submit response or the authored template. */
const renderStatusUrl = (
  transport: PollingTransport,
  response: HttpJsonResponse,
  jobId: string | number,
): string => {
  const extracted = readJsonPointer(response.raw, transport.status_url_pointer);

  if (isString(extracted)) return extracted;

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

/** Checks the authored status URL template before a submission can create remote work. */
const assertStatusUrlTemplate = (transport: PollingTransport): void => {
  if (transport.status_url_template === undefined) return;
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
): Promise<ExchangeOutcome> => {
  const { policy, retry: retryPolicy, signal } = context;
  assertStatusUrlTemplate(transport);
  const idempotencyHeader = transport.idempotency_header;

  if (idempotencyHeader !== undefined) {
    setIdempotencyHeader(submission.headers, idempotencyHeader, request);
  }

  const pollingDelay = (retry: number, retryAfter: string | undefined): number =>
    boundedPollingDelay(transport, retryAfter, retryBackoffDelay(retryPolicy?.backoff, retry));

  // Replaying a submit can create duplicate remote work unless the server can deduplicate it.
  const submitted = await requestWithRetries(submission, context, {
    allowRetry: idempotencyHeader !== undefined,
    delayFor: pollingDelay,
  });

  if (!submitted.ok) return submitted;
  const jobId = readJsonPointer(submitted.response.raw, transport.job_id_pointer);

  if (!isString(jobId) && !isNumber(jobId)) {
    throw new AgentInvocationError('invalid_envelope', 'Polling job id extraction failed.');
  }

  const statusUrl = pollingUrl(transport, submitted.response, jobId);

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
    await abortableWait(interval, signal, () =>
      abortedError(policy.callerSignal, 'Mapped HTTP invocation'),
    );

    const polledOutcome = await requestWithRetries(pollRequest, context, {
      allowRetry: true,
      delayFor: pollingDelay,
    });

    if (!polledOutcome.ok) return polledOutcome;
    const { durationMs: polledDurationMs, response: polled } = polledOutcome;
    const status = readJsonPointer(polled.raw, transport.status_pointer);

    if (transport.success_values.some((value) => isDeepStrictEqual(value, status))) {
      return {
        ok: true,
        durationMs: polledDurationMs,
        response: polled,
        remoteJobId:
          extractRemoteJobId(polled.raw, transport.extraction.remote_job_id_pointer) ?? jobId,
      };
    }

    if (transport.failure_values.some((value) => isDeepStrictEqual(value, status))) {
      return {
        ok: false,
        durationMs: polledDurationMs,
        error: pollingFailure(transport, polled, policy.secrets),
      };
    }

    const next = parseRetryAfter(polled.headers['retry-after']) ?? interval * 2;
    interval = clampInterval(transport, next);
  }
};

export { runPolling };
