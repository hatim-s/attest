import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

import type { AgentInvocationError } from '../../errors.js';
import type { ResolvedHttpUrl } from './url-security.js';

/** What the server sent first: ordinary response headers or an accepted protocol upgrade. */
type PinnedResponse =
  | { kind: 'response'; response: IncomingMessage }
  | { kind: 'upgrade'; response: IncomingMessage; socket: Duplex; head: Buffer };

type PinnedRequestOptions = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Aborts the request until the first response arrives. */
  signal: AbortSignal;
  /** Deadline for the first response or upgrade after the request is sent. */
  firstByteTimeoutMs: number;
  /** Optional socket inactivity deadline while connecting and waiting for headers. */
  connectTimeoutMs?: number;
  /** Each transport names its own failures. */
  errors: {
    aborted: () => AgentInvocationError;
    firstByteTimeout: () => AgentInvocationError;
    connectTimeout?: () => AgentInvocationError;
    failed: (cause: Error) => AgentInvocationError;
  };
};

/**
 * Sends a request to the address `resolveSafeHttpUrl` already validated, so a second DNS answer
 * can never redirect the connection. Resolves when the first response or upgrade arrives; the
 * caller then owns the response body and its own deadlines.
 */
const openPinnedRequest = (
  resolved: ResolvedHttpUrl,
  options: PinnedRequestOptions,
): Promise<PinnedResponse> => {
  const { errors, signal } = options;
  if (signal.aborted) return Promise.reject(errors.aborted());
  const transport = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const outgoing = transport(resolved.url, {
      method: options.method,
      headers: options.headers,
      lookup: (_hostname, _lookupOptions, callback) =>
        callback(null, resolved.address, resolved.family),
    });
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(firstByteTimer);
      signal.removeEventListener('abort', abort);
      outcome();
    };
    const failWith = (error: AgentInvocationError): void => {
      outgoing.destroy();
      settle(() => reject(error));
    };
    const abort = (): void => failWith(errors.aborted());
    const firstByteTimer = setTimeout(
      () => failWith(errors.firstByteTimeout()),
      options.firstByteTimeoutMs,
    );
    const { connectTimeout } = errors;
    if (options.connectTimeoutMs !== undefined && connectTimeout !== undefined) {
      outgoing.setTimeout(options.connectTimeoutMs, () => failWith(connectTimeout()));
    }
    outgoing.once('response', (response) => {
      // The response body owns its own idle deadline after headers arrive.
      outgoing.setTimeout(0);
      settle(() => resolve({ kind: 'response', response }));
    });
    outgoing.once('upgrade', (response, socket, head) => {
      settle(() => resolve({ kind: 'upgrade', response, socket, head }));
    });
    // Stays attached after settlement so a late socket error cannot become an uncaught event.
    outgoing.on('error', (error) => settle(() => reject(errors.failed(error))));
    signal.addEventListener('abort', abort, { once: true });
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
};

export { openPinnedRequest, type PinnedResponse };
