import { AgentInvocationError, abortedError } from '../../errors.js';
import { DEFAULT_CONNECT_MS, DEFAULT_FIRST_BYTE_MS } from '../../internal/agent-defaults.js';
import { openPinnedRequest } from '../http/pinned-request.js';
import { resolveSafeHttpUrl } from '../http/url-security.js';
import type { StreamHttpTransport } from './stream-transport.js';

/** Opens the local DNS-pinned transport; stream parsing stays shared with other hosts. */
const openNodeStream: StreamHttpTransport = async (agent, materialized, signal, options) => {
  const connectTimeoutMs = agent.timeouts?.connect_ms ?? DEFAULT_CONNECT_MS;
  const resolved = await resolveSafeHttpUrl(materialized.url, {
    timeoutMs: connectTimeoutMs,
    signal,
    callerSignal: options.signal,
  });
  if (
    (options.secrets?.length ?? 0) > 0 &&
    resolved.url.protocol !== 'https:' &&
    !resolved.loopback
  ) {
    throw new AgentInvocationError(
      'network',
      'Streaming secrets require HTTPS except on loopback.',
    );
  }
  const { response } = await openPinnedRequest(resolved, {
    method: materialized.method,
    headers: materialized.headers,
    body: materialized.body,
    signal,
    firstByteTimeoutMs: agent.timeouts?.first_byte_ms ?? DEFAULT_FIRST_BYTE_MS,
    connectTimeoutMs,
    errors: {
      aborted: () => abortedError(options.signal, 'Streaming invocation'),
      firstByteTimeout: () =>
        new AgentInvocationError('timeout', 'Streaming HTTP first byte timed out.'),
      connectTimeout: () =>
        new AgentInvocationError('timeout', 'Streaming HTTP connection timed out.'),
      failed: (cause) =>
        new AgentInvocationError('network', 'Streaming HTTP transport failed.', { cause }),
    },
  });
  const status = response.statusCode ?? 0;
  return {
    status,
    headers: {
      'content-type': String(response.headers['content-type'] ?? ''),
      'retry-after': response.headersDistinct['retry-after']?.[0] ?? '',
    },
    body: response as AsyncIterable<Uint8Array>,
    cancel: () => response.destroy(),
  };
};

export { openNodeStream };
