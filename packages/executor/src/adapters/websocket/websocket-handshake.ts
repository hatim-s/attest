import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

import type { AgentInvocationError } from '../../errors.js';
import { resolveSafeHttpUrl } from '../http/url-security.js';
import { classifiedError } from './websocket-protocol.js';

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

type ClassifiedWebSocketError = AgentInvocationError & {
  webSocketClassification?: 'connection_failed' | 'handshake_failed' | 'open_timeout';
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
    throw classifiedError('connection_failed', 'network', 'WebSocket URL is invalid.', cause);
  }
  if (
    !['ws:', 'wss:'].includes(webSocketUrl.protocol) ||
    webSocketUrl.username.length > 0 ||
    webSocketUrl.password.length > 0 ||
    webSocketUrl.hash.length > 0
  ) {
    throw classifiedError(
      'connection_failed',
      'network',
      'WebSocket URL must use WS(S) without credentials or a fragment.',
    );
  }

  const httpUrl = new URL(webSocketUrl);
  httpUrl.protocol = webSocketUrl.protocol === 'wss:' ? 'https:' : 'http:';
  const resolved = await resolveSafeHttpUrl(
    httpUrl.toString(),
    options.openTimeoutMs,
    options.signal,
    options.callerSignal,
  );
  if (options.secrets.length > 0 && webSocketUrl.protocol !== 'wss:' && !resolved.loopback) {
    throw classifiedError(
      'connection_failed',
      'network',
      'WebSocket secrets require WSS except on explicit loopback endpoints.',
    );
  }

  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
  const transport = webSocketUrl.protocol === 'wss:' ? httpsRequest : httpRequest;
  return new Promise<WebSocketUpgrade>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      options.signal.removeEventListener('abort', abort);
      operation();
    };
    const outgoing = transport(resolved.url, {
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
      lookup: (_hostname, _lookupOptions, callback) =>
        callback(null, resolved.address, resolved.family),
    });
    const abort = (): void => {
      outgoing.destroy();
      const cancelled = options.callerSignal?.aborted === true;
      finish(() =>
        reject(
          classifiedError(
            'open_timeout',
            cancelled ? 'cancelled' : 'timeout',
            cancelled ? 'WebSocket opening was cancelled.' : 'WebSocket opening timed out.',
          ),
        ),
      );
    };
    const openTimer = setTimeout(() => {
      outgoing.destroy();
      finish(() =>
        reject(classifiedError('open_timeout', 'timeout', 'WebSocket opening timed out.')),
      );
    }, options.openTimeoutMs);
    options.signal.addEventListener('abort', abort, { once: true });
    outgoing.once('upgrade', (response, socket, head) => {
      const accept = response.headers['sec-websocket-accept'];
      const selectedProtocol = response.headers['sec-websocket-protocol'];
      if (
        response.statusCode !== 101 ||
        String(response.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
        String(accept ?? '') !== expectedAccept ||
        (options.subprotocol !== undefined && selectedProtocol !== options.subprotocol) ||
        (options.subprotocol === undefined && selectedProtocol !== undefined)
      ) {
        socket.destroy();
        finish(() =>
          reject(
            classifiedError('handshake_failed', 'network', 'WebSocket handshake was rejected.'),
          ),
        );
        return;
      }
      finish(() => resolve({ head, socket }));
    });
    outgoing.once('response', (response) => {
      response.resume();
      finish(() =>
        reject(
          classifiedError(
            'handshake_failed',
            'network',
            `WebSocket handshake returned status ${String(response.statusCode ?? 0)}.`,
          ),
        ),
      );
    });
    outgoing.once('error', (error) =>
      finish(() =>
        reject(
          classifiedError('connection_failed', 'network', 'WebSocket connection failed.', error),
        ),
      ),
    );
    outgoing.end();
    if (options.signal.aborted) abort();
  });
};

export { openWebSocketHandshake, type ClassifiedWebSocketError };
