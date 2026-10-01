import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { openPinnedRequest } from '../http/pinned-request.js';
import { resolveSafeHttpUrl } from '../http/url-security.js';

type OpenWebSocketHandshakeOptions = {
  callerSignal?: AbortSignal;
  headers: Record<string, string>;
  openTimeoutMs: number;
  secrets: readonly string[];
  signal: AbortSignal;
  subprotocol?: string;
  url: string;
};

type WebSocketUpgrade = {
  head: Buffer;
  socket: Duplex;
};

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Opens a DNS-pinned RFC 6455 socket and validates the complete upgrade response. */
const openWebSocketHandshake = async (
  options: OpenWebSocketHandshakeOptions,
): Promise<WebSocketUpgrade> => {
  let webSocketUrl: URL;
  try {
    webSocketUrl = new URL(options.url);
  } catch (cause: unknown) {
    throw new AgentInvocationError('network', 'WebSocket URL is invalid.', {
      cause,
      classification: 'connection_failed',
    });
  }
  if (
    !['ws:', 'wss:'].includes(webSocketUrl.protocol) ||
    webSocketUrl.username.length > 0 ||
    webSocketUrl.password.length > 0 ||
    webSocketUrl.hash.length > 0
  ) {
    throw new AgentInvocationError(
      'network',
      'WebSocket URL must use WS(S) without credentials or a fragment.',
      { classification: 'connection_failed' },
    );
  }

  const httpUrl = new URL(webSocketUrl);
  httpUrl.protocol = webSocketUrl.protocol === 'wss:' ? 'https:' : 'http:';
  const resolved = await resolveSafeHttpUrl(httpUrl.toString(), {
    timeoutMs: options.openTimeoutMs,
    signal: options.signal,
    callerSignal: options.callerSignal,
  });
  if (options.secrets.length > 0 && webSocketUrl.protocol !== 'wss:' && !resolved.loopback) {
    throw new AgentInvocationError(
      'network',
      'WebSocket secrets require WSS except on explicit loopback endpoints.',
      { classification: 'connection_failed' },
    );
  }

  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
  const opened = await openPinnedRequest(resolved, {
    method: 'GET',
    headers: {
      ...options.headers,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
      ...(options.subprotocol === undefined
        ? {}
        : { 'sec-websocket-protocol': options.subprotocol }),
    },
    signal: options.signal,
    firstByteTimeoutMs: options.openTimeoutMs,
    errors: {
      aborted: () =>
        abortedError(options.callerSignal, 'WebSocket opening', {
          classification: 'open_timeout',
        }),
      firstByteTimeout: () =>
        new AgentInvocationError('timeout', 'WebSocket opening timed out.', {
          classification: 'open_timeout',
        }),
      failed: (cause) =>
        new AgentInvocationError('network', 'WebSocket connection failed.', {
          cause,
          classification: 'connection_failed',
        }),
    },
  });
  if (opened.kind === 'response') {
    opened.response.resume();
    throw new AgentInvocationError(
      'network',
      `WebSocket handshake returned status ${String(opened.response.statusCode ?? 0)}.`,
      { classification: 'handshake_failed' },
    );
  }
  const { head, response, socket } = opened;
  const selectedProtocol = response.headers['sec-websocket-protocol'];
  const accepted =
    response.statusCode === 101 &&
    String(response.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    String(response.headers['sec-websocket-accept'] ?? '') === expectedAccept &&
    selectedProtocol === options.subprotocol;
  if (!accepted) {
    socket.destroy();
    throw new AgentInvocationError('network', 'WebSocket handshake was rejected.', {
      classification: 'handshake_failed',
    });
  }
  return { head, socket };
};

export { openWebSocketHandshake };
