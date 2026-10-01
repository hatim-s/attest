import type { IncomingMessage } from 'node:http';

import type { RawExcerpt } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { appendEvidencePrefix, createRawExcerpt } from '../../internal/raw-excerpt.js';
import { openPinnedRequest } from './pinned-request.js';
import type { MaterializedHttpRequest } from './request-template.js';
import { redactTransportText } from './redaction.js';
import { requireSameOrigin, resolveSafeHttpUrl } from './url-security.js';

type HttpClientPolicy = {
  attemptSignal: AbortSignal;
  callerSignal?: AbortSignal;
  connectTimeoutMs: number;
  firstByteTimeoutMs: number;
  responseBodyTimeoutMs: number;
  responseCapBytes: number;
  secrets: readonly string[];
};

type HttpJsonResponse = {
  headers: Record<string, string>;
  raw: unknown;
  rawExcerpt: RawExcerpt;
  status: number;
  url: URL;
};

const MAX_REDIRECTS = 3;

const abortError = (policy: HttpClientPolicy): AgentInvocationError =>
  abortedError(policy.callerSignal, 'Mapped HTTP request');

const normalizeHeaders = (headers: NodeJS.Dict<string | string[]>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(', ') : value,
      ]),
  );

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

/**
 * Reads one response body while enforcing cancellation, idle, and aggregate byte caps. Only a
 * success body is parsed as JSON; other statuses keep their text as evidence only.
 */
const readResponseBody = async (
  response: IncomingMessage,
  policy: HttpClientPolicy,
): Promise<{ raw: unknown; rawExcerpt: RawExcerpt }> => {
  const chunks: Buffer[] = [];
  const evidence: Uint8Array[] = [];
  let byteCount = 0;
  let evidenceBytes = 0;
  let interruption: AgentInvocationError | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  // Destroying the response ends the read loop; `interruption` records why it was stopped.
  const interrupt = (error: AgentInvocationError): void => {
    interruption ??= error;
    response.destroy(error);
  };
  const resetIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => interrupt(new AgentInvocationError('timeout', 'Mapped HTTP response body timed out.')),
      policy.responseBodyTimeoutMs,
    );
  };
  const abort = (): void => interrupt(abortError(policy));
  policy.attemptSignal.addEventListener('abort', abort, { once: true });
  try {
    if (policy.attemptSignal.aborted) throw abortError(policy);
    resetIdle();
    for await (const chunk of response as AsyncIterable<Buffer>) {
      resetIdle();
      byteCount += chunk.byteLength;
      evidenceBytes = appendEvidencePrefix(evidence, evidenceBytes, chunk);
      if (byteCount > policy.responseCapBytes) {
        const prefix = Buffer.concat(evidence, evidenceBytes).toString('utf8');
        throw new AgentInvocationError(
          'output_cap_exceeded',
          `Mapped HTTP response exceeds the ${policy.responseCapBytes}-byte response cap.`,
          {
            rawExcerpt: {
              ...createRawExcerpt(redactTransportText(prefix, policy.secrets)),
              truncated: true,
            },
          },
        );
      }
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    throw interruption ?? error;
  } finally {
    clearTimeout(idleTimer);
    policy.attemptSignal.removeEventListener('abort', abort);
    // Do not let an idle or capped response survive the invocation as background socket I/O.
    response.destroy();
  }

  const text = Buffer.concat(chunks, byteCount).toString('utf8');
  const rawExcerpt = createRawExcerpt(redactTransportText(text, policy.secrets));
  if (!isSuccessStatus(response.statusCode ?? 0)) return { raw: null, rawExcerpt };
  try {
    return { raw: JSON.parse(text) as unknown, rawExcerpt };
  } catch (error: unknown) {
    throw new AgentInvocationError('invalid_envelope', 'Mapped HTTP response is not valid JSON.', {
      cause: error,
      rawExcerpt,
    });
  }
};

/** Performs one DNS-pinned request and returns only bounded JSON evidence. */
const requestOnce = async (
  request: MaterializedHttpRequest,
  policy: HttpClientPolicy,
): Promise<HttpJsonResponse> => {
  if (policy.attemptSignal.aborted) throw abortError(policy);
  const resolved = await resolveSafeHttpUrl(request.url, {
    timeoutMs: policy.connectTimeoutMs,
    signal: policy.attemptSignal,
    callerSignal: policy.callerSignal,
  });
  if (policy.secrets.length > 0 && resolved.url.protocol !== 'https:' && !resolved.loopback) {
    throw new AgentInvocationError(
      'network',
      'Mapped HTTP secrets require HTTPS except for explicit loopback endpoints.',
    );
  }
  const opened = await openPinnedRequest(resolved, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: policy.attemptSignal,
    firstByteTimeoutMs: policy.firstByteTimeoutMs,
    connectTimeoutMs: policy.connectTimeoutMs,
    errors: {
      aborted: () => abortError(policy),
      firstByteTimeout: () =>
        new AgentInvocationError('timeout', 'Mapped HTTP first byte timed out.'),
      connectTimeout: () =>
        new AgentInvocationError('timeout', 'Mapped HTTP connection timed out.'),
      failed: (cause) =>
        new AgentInvocationError('network', 'Mapped HTTP transport failed.', { cause }),
    },
  });
  const { response } = opened;
  const { raw, rawExcerpt } = await readResponseBody(response, policy);
  return {
    headers: normalizeHeaders(response.headers),
    raw,
    rawExcerpt,
    status: response.statusCode ?? 0,
    url: resolved.url,
  };
};

/** Follows only bounded, method-preserving, same-origin redirects. */
const requestJson = async (
  request: MaterializedHttpRequest,
  policy: HttpClientPolicy,
): Promise<HttpJsonResponse> => {
  const origin = new URL(request.url);
  let current = request;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await requestOnce(current, policy);
    if (![307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (location === undefined || redirects === MAX_REDIRECTS) {
      throw new AgentInvocationError(
        'http_status',
        `Mapped HTTP returned status ${response.status}.`,
        { httpStatus: response.status, rawExcerpt: response.rawExcerpt },
      );
    }
    const redirected = new URL(location, response.url);
    requireSameOrigin(redirected, origin);
    current = { ...current, url: redirected.toString() };
  }
  throw new AgentInvocationError('http_status', 'Mapped HTTP redirect limit was exceeded.');
};

export { requestJson, type HttpClientPolicy, type HttpJsonResponse };
