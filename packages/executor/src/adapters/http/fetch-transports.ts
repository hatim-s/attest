import { AgentInvocationError, abortedError } from '../../errors.js';
import { DEFAULT_CONNECT_MS, DEFAULT_FIRST_BYTE_MS } from '../../internal/agent-defaults.js';
import { appendEvidencePrefix, createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { StreamHttpResponse, StreamHttpTransport } from '../stream/stream-transport.js';
import type { HttpClientPolicy, HttpJsonTransport } from './http-client.js';
import { redactTransportText } from './redaction.js';
import type { MaterializedHttpRequest } from './request-template.js';
import { requireSameOrigin } from './same-origin.js';

/** The host validates and pins destinations before forwarding requests, including redirects. */
type GuardedHttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Opens headers with a bounded deadline and transfers cancellation to the returned body. */
const openFetchResponse = async (
  guardedFetch: GuardedHttpFetch,
  request: MaterializedHttpRequest,
  signal: AbortSignal,
  firstByteMs: number,
): Promise<StreamHttpResponse> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    firstByteMs,
  );
  let response: Response;
  try {
    response = await guardedFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error: unknown) {
    signal.removeEventListener('abort', abort);
    if (controller.signal.aborted && !signal.aborted) {
      throw new AgentInvocationError('timeout', 'HTTP first byte timed out.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const reader = response.body?.getReader();
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    signal.removeEventListener('abort', abort);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  };
  const body = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      if (reader === undefined) return;
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      cancel();
      reader?.releaseLock();
    }
  })();
  return { status: response.status, headers: Object.fromEntries(response.headers), body, cancel };
};

/** Reads JSON evidence with the same byte and idle limits as the pinned local transport. */
const readFetchJson = async (
  response: StreamHttpResponse,
  policy: HttpClientPolicy,
): Promise<{ raw: unknown; rawExcerpt: ReturnType<typeof createRawExcerpt> }> => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const evidence: Uint8Array[] = [];
  let evidenceBytes = 0;
  let interruption: AgentInvocationError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (error: AgentInvocationError): void => {
    interruption ??= error;
    response.cancel();
  };
  const abort = (): void => interrupt(abortedError(policy.callerSignal, 'Mapped HTTP request'));
  const resetIdle = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => interrupt(new AgentInvocationError('timeout', 'Mapped HTTP response body timed out.')),
      policy.responseBodyTimeoutMs,
    );
  };
  policy.attemptSignal.addEventListener('abort', abort, { once: true });
  try {
    if (policy.attemptSignal.aborted)
      throw abortedError(policy.callerSignal, 'Mapped HTTP request');
    resetIdle();
    for await (const chunk of response.body) {
      resetIdle();
      bytes += chunk.byteLength;
      evidenceBytes = appendEvidencePrefix(evidence, evidenceBytes, chunk);
      if (bytes > policy.responseCapBytes) {
        throw new AgentInvocationError(
          'output_cap_exceeded',
          `Mapped HTTP response exceeds the ${policy.responseCapBytes}-byte response cap.`,
          {
            rawExcerpt: {
              ...createRawExcerpt(
                redactTransportText(
                  Buffer.concat(evidence, evidenceBytes).toString('utf8'),
                  policy.secrets,
                ),
              ),
              truncated: true,
            },
          },
        );
      }
      chunks.push(chunk);
    }
    if (interruption !== undefined) throw interruption;
    const payload = Buffer.concat(chunks, bytes).toString('utf8');
    const rawExcerpt = createRawExcerpt(redactTransportText(payload, policy.secrets));
    if (response.status < 200 || response.status >= 300) return { raw: null, rawExcerpt };
    try {
      return { raw: JSON.parse(payload) as unknown, rawExcerpt };
    } catch (error: unknown) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Mapped HTTP response is not valid JSON.',
        { cause: error, rawExcerpt },
      );
    }
  } catch (error: unknown) {
    throw interruption ?? error;
  } finally {
    clearTimeout(timer);
    policy.attemptSignal.removeEventListener('abort', abort);
    response.cancel();
  }
};

/**
 * Adapts host-guarded fetch to shared mapped JSON, polling, SSE and JSONL execution.
 * This does not validate DNS. The host must enforce its network policy before every fetch.
 * Neither adapter retries requests; replay remains controlled by the invocation options.
 */
const createFetchHttpTransports = (
  guardedFetch: GuardedHttpFetch,
): {
  requestJson: HttpJsonTransport;
  requestStream: StreamHttpTransport;
} => {
  const requestJson: HttpJsonTransport = async (request, policy) => {
    const origin = new URL(request.url);
    let current = request;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await openFetchResponse(
        guardedFetch,
        current,
        policy.attemptSignal,
        Math.min(policy.connectTimeoutMs, policy.firstByteTimeoutMs),
      );
      const parsed = await readFetchJson(response, policy);
      const result = {
        ...parsed,
        status: response.status,
        headers: response.headers,
        url: new URL(current.url),
      };
      if (![307, 308].includes(response.status)) return result;
      const location = response.headers.location;
      if (location === undefined || redirects === 3) {
        throw new AgentInvocationError(
          'http_status',
          `Mapped HTTP returned status ${response.status}.`,
          { httpStatus: response.status, rawExcerpt: parsed.rawExcerpt },
        );
      }
      const redirected = new URL(location, result.url);
      requireSameOrigin(redirected, origin);
      current = { ...current, url: redirected.toString() };
    }
    throw new AgentInvocationError('http_status', 'Mapped HTTP redirect limit was exceeded.');
  };
  const requestStream: StreamHttpTransport = (agent, request, signal) =>
    openFetchResponse(
      guardedFetch,
      request,
      signal,
      Math.min(
        agent.timeouts?.connect_ms ?? DEFAULT_CONNECT_MS,
        agent.timeouts?.first_byte_ms ?? DEFAULT_FIRST_BYTE_MS,
      ),
    );
  return { requestJson, requestStream };
};

export { createFetchHttpTransports, type GuardedHttpFetch };
