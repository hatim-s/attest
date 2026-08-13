import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_WAIT_TIMEOUT_MS = 2_000;
const SECRET_BEARING_FIXTURE_VALUE = 'fixture-websocket-secret-never-persist';

const webSocketFixtureScenarioNames = [
  'serial_correlation',
  'multiplexed_out_of_order',
  'ack_then_disconnect',
  'disconnect_before_ack_then_reconnect',
  'ping_pong',
  'idle',
  'graceful_close',
  'forced_close',
  'malformed_json',
  'unmatched_json',
  'oversized_message',
  'binary_frame',
  'uncorrelated_server_work',
  'delayed_open',
  'secret_bearing_evidence',
] as const;

type WebSocketFixtureScenarioName = (typeof webSocketFixtureScenarioNames)[number];

type WebSocketFixtureEvent = {
  type:
    | 'upgrade_requested'
    | 'connection_opened'
    | 'request_received'
    | 'text_sent'
    | 'binary_sent'
    | 'ping_sent'
    | 'pong_received'
    | 'close_sent'
    | 'close_received'
    | 'connection_ended'
    | 'forced_close';
  connectionId: number;
  elapsedMs: number;
  requestId?: string;
  bytes?: number;
  code?: number;
  reason?: string;
  headers?: Readonly<Record<string, string>>;
};

type WebSocketFixtureServerOptions = {
  openDelayMs?: number;
  oversizedMessageBytes?: number;
};

type WebSocketFixtureServer = {
  url: string;
  scenario: WebSocketFixtureScenarioName;
  events: () => readonly WebSocketFixtureEvent[];
  waitForEvent: (
    predicate: (event: WebSocketFixtureEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<WebSocketFixtureEvent>;
  close: () => Promise<void>;
};

type FixtureRequest = {
  request_id: string;
  [key: string]: unknown;
};

type ParsedFrame = {
  consumedBytes: number;
  opcode: number;
  payload: Buffer;
};

type EventWaiter = {
  predicate: (event: WebSocketFixtureEvent) => boolean;
  resolve: (event: WebSocketFixtureEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Encodes one unmasked server-to-client frame, including hostile large payloads. */
const encodeServerFrame = (opcode: number, payload: Buffer): Buffer => {
  const firstByte = 0x80 | opcode;
  if (payload.byteLength < 126) {
    return Buffer.concat([Buffer.from([firstByte, payload.byteLength]), payload]);
  }

  if (payload.byteLength <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.allocUnsafe(10);
  header[0] = firstByte;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  return Buffer.concat([header, payload]);
};

/** Parses one complete masked client frame and leaves incomplete data buffered. */
const parseClientFrame = (buffer: Buffer): ParsedFrame | undefined => {
  if (buffer.byteLength < 2) return undefined;

  const secondByte = buffer[1];
  if (secondByte === undefined) return undefined;
  const isMasked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.byteLength < 4) return undefined;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.byteLength < 10) return undefined;
    const longLength = buffer.readBigUInt64BE(2);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Fixture frame is too large.');
    payloadLength = Number(longLength);
    offset = 10;
  }

  const maskBytes = isMasked ? 4 : 0;
  const consumedBytes = offset + maskBytes + payloadLength;
  if (buffer.byteLength < consumedBytes) return undefined;

  const payload = Buffer.from(buffer.subarray(offset + maskBytes, consumedBytes));
  if (isMasked) {
    const mask = buffer.subarray(offset, offset + 4);
    for (let index = 0; index < payload.byteLength; index += 1) {
      const maskByte = mask[index % 4];
      if (maskByte !== undefined) payload[index] = (payload[index] ?? 0) ^ maskByte;
    }
  }

  return { consumedBytes, opcode: buffer[0] === undefined ? 0 : buffer[0] & 0x0f, payload };
};

/** Normalizes Node's upgrade headers into an immutable, assertion-friendly record. */
const normalizedHeaders = (request: IncomingMessage): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(request.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
      ),
    ),
  );

/** Reads the fixture correlation key without accepting malformed request envelopes. */
const parseFixtureRequest = (payload: Buffer): FixtureRequest | undefined => {
  try {
    const value: unknown = JSON.parse(payload.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const requestId = (value as Record<string, unknown>).request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) return undefined;
    return value as FixtureRequest;
  } catch {
    return undefined;
  }
};

/** Starts one deterministic hostile WebSocket endpoint for adapter and integration tests. */
const startWebSocketFixtureServer = async (
  scenario: WebSocketFixtureScenarioName,
  options: WebSocketFixtureServerOptions = {},
): Promise<WebSocketFixtureServer> => {
  const startedAt = Date.now();
  const recordedEvents: WebSocketFixtureEvent[] = [];
  const waiters = new Set<EventWaiter>();
  const sockets = new Set<Duplex>();
  const scheduledTasks = new Set<ReturnType<typeof setTimeout>>();
  const multiplexedRequests: Array<{ connection: FixtureConnection; request: FixtureRequest }> = [];
  let connectionCount = 0;

  /** Records observable behavior and resolves matching integration-lane waiters. */
  const record = (event: Omit<WebSocketFixtureEvent, 'elapsedMs'>): void => {
    const completeEvent = { ...event, elapsedMs: Date.now() - startedAt };
    recordedEvents.push(completeEvent);
    for (const waiter of waiters) {
      if (!waiter.predicate(completeEvent)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(completeEvent);
    }
  };

  /** Schedules short scenario actions while keeping teardown deterministic. */
  const schedule = (action: () => void, delayMs = 0): void => {
    const timer = setTimeout(() => {
      scheduledTasks.delete(timer);
      action();
    }, delayMs);
    scheduledTasks.add(timer);
  };

  class FixtureConnection {
    readonly id: number;
    readonly socket: Duplex;
    private buffer = Buffer.alloc(0);
    private ended = false;

    constructor(id: number, socket: Duplex) {
      this.id = id;
      this.socket = socket;
      socket.on('data', (chunk: Buffer) => this.receive(chunk));
      socket.once('close', () => {
        this.ended = true;
        sockets.delete(socket);
        record({ type: 'connection_ended', connectionId: id });
      });
      socket.on('error', () => {
        // Hostile forced-close scenarios intentionally surface transport errors to the peer.
      });
    }

    /** Sends a JSON-shaped text message without applying adapter-side interpretation. */
    sendJson(value: unknown): void {
      this.sendText(JSON.stringify(value));
    }

    /** Sends exact text so malformed JSON remains reproducible. */
    sendText(value: string): void {
      const payload = Buffer.from(value, 'utf8');
      this.writeFrame(0x1, payload);
      record({ type: 'text_sent', connectionId: this.id, bytes: payload.byteLength });
    }

    /** Sends an unsupported binary frame for negative adapter coverage. */
    sendBinary(value: Buffer): void {
      this.writeFrame(0x2, value);
      record({ type: 'binary_sent', connectionId: this.id, bytes: value.byteLength });
    }

    /** Sends a protocol ping; conforming clients reply with pong without app involvement. */
    ping(value: string): void {
      const payload = Buffer.from(value, 'utf8');
      this.writeFrame(0x9, payload);
      record({ type: 'ping_sent', connectionId: this.id, bytes: payload.byteLength });
    }

    /** Initiates a standards-compliant close handshake with deterministic evidence. */
    gracefulClose(code = 1000, reason = 'fixture complete'): void {
      const reasonBytes = Buffer.from(reason, 'utf8');
      const payload = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      this.writeFrame(0x8, payload);
      record({ type: 'close_sent', connectionId: this.id, code, reason });
    }

    /** Ends the transport without a close frame to emulate network loss. */
    forceClose(): void {
      if (this.ended) return;
      record({ type: 'forced_close', connectionId: this.id });
      this.socket.destroy();
    }

    private writeFrame(opcode: number, payload: Buffer): void {
      if (!this.ended) this.socket.write(encodeServerFrame(opcode, payload));
    }

    private receive(chunk: Buffer): void {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.byteLength > 0) {
        const frame = parseClientFrame(this.buffer);
        if (frame === undefined) return;
        this.buffer = this.buffer.subarray(frame.consumedBytes);
        this.handleFrame(frame.opcode, frame.payload);
      }
    }

    private handleFrame(opcode: number, payload: Buffer): void {
      if (opcode === 0x1) {
        const request = parseFixtureRequest(payload);
        if (request !== undefined) {
          record({
            type: 'request_received',
            connectionId: this.id,
            requestId: request.request_id,
            bytes: payload.byteLength,
          });
          handleRequest(this, request);
        }
        return;
      }

      if (opcode === 0x8) {
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : undefined;
        const reason = payload.subarray(2).toString('utf8');
        record({ type: 'close_received', connectionId: this.id, code, reason });
        if (!this.ended) this.socket.end(encodeServerFrame(0x8, payload));
        return;
      }

      if (opcode === 0x9) {
        this.writeFrame(0x0a, payload);
        return;
      }

      if (opcode === 0x0a) {
        record({ type: 'pong_received', connectionId: this.id, bytes: payload.byteLength });
      }
    }
  }

  /** Dispatches one correlated request through the selected hostile scenario. */
  const handleRequest = (connection: FixtureConnection, request: FixtureRequest): void => {
    const acknowledgement = { request_id: request.request_id, type: 'acknowledgement' };
    const result = {
      request_id: request.request_id,
      type: 'result',
      result: { echoed_request_id: request.request_id },
    };

    switch (scenario) {
      case 'serial_correlation':
      case 'delayed_open':
        connection.sendJson(acknowledgement);
        connection.sendJson(result);
        return;
      case 'multiplexed_out_of_order':
        connection.sendJson(acknowledgement);
        multiplexedRequests.push({ connection, request });
        if (multiplexedRequests.length === 2) {
          // Reverse completion order proves consumers correlate instead of using FIFO position.
          const completionBatch = multiplexedRequests.splice(0, 2).reverse();
          for (const pending of completionBatch) {
            pending.connection.sendJson({
              request_id: pending.request.request_id,
              type: 'result',
              result: { completion_order: 'reverse' },
            });
          }
        }
        return;
      case 'ack_then_disconnect':
        connection.sendJson(acknowledgement);
        schedule(() => connection.forceClose());
        return;
      case 'disconnect_before_ack_then_reconnect':
        if (connection.id === 1) {
          connection.forceClose();
        } else {
          connection.sendJson(acknowledgement);
          connection.sendJson(result);
        }
        return;
      case 'graceful_close':
        connection.gracefulClose(1000, 'fixture graceful close');
        return;
      case 'forced_close':
        connection.forceClose();
        return;
      case 'malformed_json':
        connection.sendText('{"request_id":');
        return;
      case 'unmatched_json':
        connection.sendJson({ request_id: 'fixture-unmatched', type: 'result', result: null });
        return;
      case 'oversized_message': {
        const requestedBytes = options.oversizedMessageBytes ?? 70_000;
        connection.sendJson({
          request_id: request.request_id,
          type: 'result',
          result: 'x'.repeat(requestedBytes),
        });
        return;
      }
      case 'binary_frame':
        connection.sendBinary(Buffer.from(JSON.stringify(result), 'utf8'));
        return;
      case 'secret_bearing_evidence':
        connection.sendJson(acknowledgement);
        connection.sendJson({
          request_id: request.request_id,
          type: 'result',
          result: {
            authorization: `Bearer ${SECRET_BEARING_FIXTURE_VALUE}`,
            nested: { api_key: SECRET_BEARING_FIXTURE_VALUE },
          },
          trace: { token: SECRET_BEARING_FIXTURE_VALUE },
        });
        return;
      case 'ping_pong':
      case 'idle':
      case 'uncorrelated_server_work':
        return;
    }
  };

  const server: Server = createServer();
  server.on('upgrade', (request, socket) => {
    connectionCount += 1;
    const connectionId = connectionCount;
    sockets.add(socket);
    record({
      type: 'upgrade_requested',
      connectionId,
      headers: normalizedHeaders(request),
    });

    const openConnection = (): void => {
      if (socket.destroyed) return;
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }

      // RFC 6455 requires SHA-1 for this handshake value; it is not a security control.
      const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
      const requestedProtocol = request.headers['sec-websocket-protocol']?.split(',')[0]?.trim();
      const protocolHeader =
        requestedProtocol === undefined ? '' : `Sec-WebSocket-Protocol: ${requestedProtocol}\r\n`;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocolHeader}\r\n`,
      );
      const connection = new FixtureConnection(connectionId, socket);
      record({
        type: 'connection_opened',
        connectionId,
        headers: normalizedHeaders(request),
      });

      if (scenario === 'ping_pong') schedule(() => connection.ping('fixture-ping'));
      if (scenario === 'uncorrelated_server_work') {
        schedule(() => connection.sendJson({ type: 'work', input: 'server initiated' }));
      }
    };

    schedule(openConnection, scenario === 'delayed_open' ? (options.openDelayMs ?? 75) : 0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    scenario,
    events: () => recordedEvents.map((event) => ({ ...event })),
    waitForEvent: (predicate, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) => {
      const existing = recordedEvents.find(predicate);
      if (existing !== undefined) return Promise.resolve({ ...existing });

      return new Promise<WebSocketFixtureEvent>((resolve, reject) => {
        const waiter: EventWaiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${scenario} fixture event.`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    close: async () => {
      for (const task of scheduledTasks) clearTimeout(task);
      scheduledTasks.clear();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Closed ${scenario} fixture before awaited event.`));
      }
      waiters.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
};

export {
  SECRET_BEARING_FIXTURE_VALUE,
  startWebSocketFixtureServer,
  webSocketFixtureScenarioNames,
  type WebSocketFixtureEvent,
  type WebSocketFixtureScenarioName,
  type WebSocketFixtureServer,
  type WebSocketFixtureServerOptions,
};
