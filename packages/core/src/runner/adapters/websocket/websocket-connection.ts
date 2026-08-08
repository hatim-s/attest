import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

import { AgentInvocationError } from '../../errors.js';
import { resolveSafeHttpUrl } from '../http/url-security.js';

type WebSocketClose = { clean: boolean; code?: number; reason?: string };

type WebSocketConnectionCallbacks = {
  onClose: (close: WebSocketClose) => void;
  onFailure: (error: AgentInvocationError) => void;
  onPong: () => void;
  onText: (text: string, bytes: number) => void;
};

type OpenWebSocketOptions = {
  callerSignal?: AbortSignal;
  callbacks: WebSocketConnectionCallbacks;
  headers: Record<string, string>;
  maximumMessageBytes: number;
  openTimeoutMs: number;
  secrets: readonly string[];
  signal: AbortSignal;
  subprotocol?: string;
  url: string;
};

type ClassifiedWebSocketError = AgentInvocationError & {
  webSocketClassification?: 'connection_failed' | 'handshake_failed' | 'open_timeout';
};

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Adds a stable WebSocket evidence classification without widening the public error contract. */
const classifiedError = (
  classification: NonNullable<ClassifiedWebSocketError['webSocketClassification']>,
  code: 'cancelled' | 'network' | 'timeout',
  message: string,
  cause?: unknown,
): ClassifiedWebSocketError =>
  Object.assign(
    new AgentInvocationError(code, message, cause === undefined ? undefined : { cause }),
    {
      webSocketClassification: classification,
    },
  );

/** Encodes one client-to-server frame with the masking required by RFC 6455. */
const encodeFrame = (
  opcode: number,
  payload: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): Buffer<ArrayBufferLike> => {
  const mask = randomBytes(4);
  const lengthBytes = payload.byteLength < 126 ? 0 : payload.byteLength <= 65_535 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + mask.byteLength);
  header[0] = 0x80 | opcode;
  if (lengthBytes === 0) {
    header[1] = 0x80 | payload.byteLength;
  } else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  mask.copy(header, 2 + lengthBytes);
  const masked = Buffer.allocUnsafe(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, masked]);
};

/** Owns one upgraded socket, including bounded frame parsing and the close handshake. */
class WebSocketConnection {
  private buffer = Buffer.alloc(0);
  private closeDetails?: WebSocketClose;
  private closePromise?: Promise<WebSocketClose>;
  private closeResolve?: (close: WebSocketClose) => void;
  private failed = false;
  private fragmentedOpcode?: number;
  private fragmentedParts: Buffer[] = [];
  private fragmentedBytes = 0;
  private receivedClose = false;
  private sentClose = false;

  constructor(
    private readonly socket: Duplex,
    private readonly maximumMessageBytes: number,
    private readonly callbacks: WebSocketConnectionCallbacks,
    initialData: Buffer,
  ) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.once('error', (error) =>
      this.fail(
        new AgentInvocationError('network', 'WebSocket connection failed.', { cause: error }),
      ),
    );
    socket.once('close', () => this.finishClose());
    if (initialData.byteLength > 0) this.consume(initialData);
  }

  /** Sends one complete text-JSON message. */
  sendText(text: string): void {
    if (this.failed || this.sentClose || this.socket.destroyed) {
      throw new AgentInvocationError('network', 'WebSocket connection is not writable.');
    }
    this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  /** Sends a protocol ping without altering application-idle state. */
  ping(): void {
    if (this.failed || this.sentClose || this.socket.destroyed) return;
    this.socket.write(encodeFrame(0x9));
  }

  /** Performs a bounded close handshake and destroys sockets that do not cooperate. */
  async close(timeoutMs: number): Promise<WebSocketClose> {
    if (this.closeDetails !== undefined) return this.closeDetails;
    if (this.closePromise === undefined) {
      this.closePromise = new Promise<WebSocketClose>((resolve) => {
        this.closeResolve = resolve;
      });
    }
    if (!this.sentClose && !this.socket.destroyed) {
      this.sentClose = true;
      const reason = Buffer.from('complete', 'utf8');
      const payload = Buffer.allocUnsafe(2 + reason.byteLength);
      payload.writeUInt16BE(1_000, 0);
      reason.copy(payload, 2);
      this.socket.write(encodeFrame(0x8, payload));
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<WebSocketClose>((resolve) => {
      timer = setTimeout(() => {
        this.socket.destroy();
        resolve({ clean: false });
      }, timeoutMs);
    });
    const completed = await Promise.race([this.closePromise, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return completed;
  }

  /** Immediately releases the socket when a run is cancelled or a protocol violation occurs. */
  destroy(): void {
    this.socket.destroy();
  }

  private consume(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.parseFrame()) {
      if (this.failed) return;
    }
  }

  private parseFrame(): boolean {
    if (this.buffer.byteLength < 2) return false;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
      this.protocolFailure('WebSocket server emitted an invalid or masked frame.');
      return false;
    }
    let headerBytes = 2;
    let payloadBytes = second & 0x7f;
    if (payloadBytes === 126) {
      if (this.buffer.byteLength < 4) return false;
      payloadBytes = this.buffer.readUInt16BE(2);
      headerBytes = 4;
    } else if (payloadBytes === 127) {
      if (this.buffer.byteLength < 10) return false;
      const extended = this.buffer.readBigUInt64BE(2);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.protocolFailure('WebSocket frame length exceeds the supported numeric range.');
        return false;
      }
      payloadBytes = Number(extended);
      headerBytes = 10;
    }
    if (opcode >= 0x8 && (!final || payloadBytes > 125)) {
      this.protocolFailure('WebSocket server emitted an invalid control frame.');
      return false;
    }
    if (payloadBytes > this.maximumMessageBytes) {
      this.fail(
        new AgentInvocationError(
          'output_cap_exceeded',
          `WebSocket message exceeds the ${this.maximumMessageBytes}-byte event cap.`,
        ),
      );
      return false;
    }
    if (this.buffer.byteLength < headerBytes + payloadBytes) return false;
    const payload = this.buffer.subarray(headerBytes, headerBytes + payloadBytes);
    this.buffer = this.buffer.subarray(headerBytes + payloadBytes);
    this.acceptFrame(opcode, final, payload);
    return true;
  }

  private acceptFrame(opcode: number, final: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.acceptClose(payload);
      return;
    }
    if (opcode === 0x9) {
      if (!this.sentClose) this.socket.write(encodeFrame(0x0a, payload));
      return;
    }
    if (opcode === 0x0a) {
      this.callbacks.onPong();
      return;
    }
    if (opcode === 0x2 || (opcode === 0x0 && this.fragmentedOpcode === 0x2)) {
      this.fail(
        Object.assign(
          new AgentInvocationError('invalid_envelope', 'Binary WebSocket frames are unsupported.'),
          { webSocketClassification: 'binary_frame_unsupported' as const },
        ),
      );
      return;
    }
    if (opcode !== 0x0 && opcode !== 0x1) {
      this.protocolFailure('WebSocket server emitted an unsupported frame opcode.');
      return;
    }
    if (opcode === 0x0 && this.fragmentedOpcode === undefined) {
      this.protocolFailure('WebSocket server emitted an unexpected continuation frame.');
      return;
    }
    if (opcode === 0x1 && this.fragmentedOpcode !== undefined) {
      this.protocolFailure('WebSocket server interleaved fragmented data messages.');
      return;
    }
    if (!final) {
      if (opcode !== 0x0) this.fragmentedOpcode = opcode;
      this.fragmentedParts.push(payload);
      this.fragmentedBytes += payload.byteLength;
      if (this.fragmentedBytes > this.maximumMessageBytes) {
        this.fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            `WebSocket message exceeds the ${this.maximumMessageBytes}-byte event cap.`,
          ),
        );
      }
      return;
    }
    const complete =
      opcode === 0x0
        ? Buffer.concat(
            [...this.fragmentedParts, payload],
            this.fragmentedBytes + payload.byteLength,
          )
        : payload;
    this.fragmentedOpcode = undefined;
    this.fragmentedParts = [];
    this.fragmentedBytes = 0;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(complete);
      this.callbacks.onText(text, complete.byteLength);
    } catch (error: unknown) {
      this.fail(
        Object.assign(
          new AgentInvocationError('invalid_envelope', 'WebSocket text is not valid UTF-8.', {
            cause: error,
          }),
          { webSocketClassification: 'invalid_json' as const },
        ),
      );
    }
  }

  private acceptClose(payload: Buffer): void {
    let code: number | undefined;
    let reason: string | undefined;
    try {
      if (payload.byteLength === 1) throw new Error('close code is truncated');
      if (payload.byteLength >= 2) {
        code = payload.readUInt16BE(0);
        reason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
      }
    } catch (error: unknown) {
      this.protocolFailure('WebSocket server emitted an invalid close frame.', error);
      return;
    }
    this.receivedClose = true;
    this.closeDetails = {
      clean: this.sentClose || code === 1_000,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 123) }),
    };
    if (!this.sentClose && !this.socket.destroyed) {
      this.sentClose = true;
      this.socket.write(encodeFrame(0x8, payload));
    }
    this.socket.end();
  }

  private protocolFailure(message: string, cause?: unknown): void {
    this.fail(
      Object.assign(
        new AgentInvocationError(
          'invalid_envelope',
          message,
          cause === undefined ? undefined : { cause },
        ),
        { webSocketClassification: 'connection_failed' as const },
      ),
    );
  }

  private fail(error: AgentInvocationError): void {
    if (this.failed) return;
    this.failed = true;
    this.callbacks.onFailure(error);
    this.socket.destroy();
  }

  private finishClose(): void {
    const close = this.closeDetails ?? { clean: this.receivedClose };
    this.closeDetails = close;
    this.closeResolve?.(close);
    this.callbacks.onClose(close);
  }
}

/** Opens a DNS-pinned RFC 6455 connection after validating the URL and handshake. */
const openWebSocket = async (options: OpenWebSocketOptions): Promise<WebSocketConnection> => {
  let webSocketUrl: URL;
  try {
    webSocketUrl = new URL(options.url);
  } catch (error: unknown) {
    throw classifiedError('connection_failed', 'network', 'WebSocket URL is invalid.', error);
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
  return new Promise<WebSocketConnection>((resolve, reject) => {
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
      finish(() =>
        reject(
          classifiedError(
            'open_timeout',
            options.callerSignal?.aborted === true ? 'cancelled' : 'timeout',
            options.callerSignal?.aborted === true
              ? 'WebSocket opening was cancelled.'
              : 'WebSocket opening timed out.',
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
      finish(() =>
        resolve(
          new WebSocketConnection(socket, options.maximumMessageBytes, options.callbacks, head),
        ),
      );
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

export {
  WebSocketConnection,
  openWebSocket,
  type ClassifiedWebSocketError,
  type OpenWebSocketOptions,
  type WebSocketClose,
  type WebSocketConnectionCallbacks,
};
