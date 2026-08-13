import { afterEach, describe, expect, it } from 'vitest';

import {
  SECRET_BEARING_FIXTURE_VALUE,
  startWebSocketFixtureServer,
  webSocketFixtureScenarioNames,
  type WebSocketFixtureServer,
} from './fixtures/websocket-fake-server.js';

type QueuedMessage = string | ArrayBuffer;

type MessageWaiter = {
  resolve: (message: QueuedMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ClosedSocket = {
  code: number;
  reason: string;
  wasClean: boolean;
};

/** Buffers native client events so fixture assertions never depend on listener timing. */
class FixtureWebSocketClient {
  readonly socket: WebSocket;
  private readonly messages: QueuedMessage[] = [];
  private readonly messageWaiters: MessageWaiter[] = [];
  private readonly closed: Promise<ClosedSocket>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      const message = event.data as QueuedMessage;
      const waiter = this.messageWaiters.shift();
      if (waiter === undefined) {
        this.messages.push(message);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
    socket.addEventListener('error', () => {
      // Forced disconnect scenarios intentionally cause a client transport error before close.
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean });
      });
    });
  }

  /** Opens a native WebSocket client against a local fixture endpoint. */
  static async connect(url: string, protocol?: string): Promise<FixtureWebSocketClient> {
    const socket = protocol === undefined ? new WebSocket(url) : new WebSocket(url, protocol);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`Failed to open ${url}.`)), {
        once: true,
      });
    });
    return new FixtureWebSocketClient(socket);
  }

  /** Sends the stable correlation envelope expected by every request-driven scenario. */
  send(requestId: string, extra: Record<string, unknown> = {}): void {
    this.socket.send(JSON.stringify({ request_id: requestId, ...extra }));
  }

  /** Reads the next text or binary message with a deterministic timeout. */
  nextMessage(timeoutMs = 1_000): Promise<QueuedMessage> {
    const message = this.messages.shift();
    if (message !== undefined) return Promise.resolve(message);

    return new Promise<QueuedMessage>((resolve, reject) => {
      const waiter: MessageWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.messageWaiters.indexOf(waiter);
          if (index >= 0) this.messageWaiters.splice(index, 1);
          reject(new Error('Timed out waiting for fixture message.'));
        }, timeoutMs),
      };
      this.messageWaiters.push(waiter);
    });
  }

  /** Resolves when the peer completes or aborts the connection. */
  waitForClose(): Promise<ClosedSocket> {
    return this.closed;
  }

  /** Best-effort cleanup for clients left open by non-close scenarios. */
  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const servers: WebSocketFixtureServer[] = [];
const clients: FixtureWebSocketClient[] = [];

/** Starts and tracks one server so failures cannot leak listening sockets. */
const start = async (
  ...parameters: Parameters<typeof startWebSocketFixtureServer>
): Promise<WebSocketFixtureServer> => {
  const server = await startWebSocketFixtureServer(...parameters);
  servers.push(server);
  return server;
};

/** Connects and tracks one client so each test owns a complete local topology. */
const connect = async (url: string, protocol?: string): Promise<FixtureWebSocketClient> => {
  const client = await FixtureWebSocketClient.connect(url, protocol);
  clients.push(client);
  return client;
};

/** Parses the text fixture envelope without embedding runtime adapter behavior in these tests. */
const jsonMessage = async (client: FixtureWebSocketClient): Promise<Record<string, unknown>> => {
  const message = await client.nextMessage();
  if (typeof message !== 'string') throw new Error('Expected a text fixture message.');
  return JSON.parse(message) as Record<string, unknown>;
};

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('WebSocket fake server correlation scenarios', () => {
  it('serves serial acknowledgements and results in request order', async () => {
    const server = await start('serial_correlation');
    const client = await connect(server.url, 'attest.fixture');

    client.send('serial-1');
    expect(await jsonMessage(client)).toMatchObject({
      request_id: 'serial-1',
      type: 'acknowledgement',
    });
    expect(await jsonMessage(client)).toMatchObject({ request_id: 'serial-1', type: 'result' });

    client.send('serial-2');
    expect(await jsonMessage(client)).toMatchObject({
      request_id: 'serial-2',
      type: 'acknowledgement',
    });
    expect(await jsonMessage(client)).toMatchObject({ request_id: 'serial-2', type: 'result' });
    expect(server.events().filter((event) => event.type === 'request_received')).toHaveLength(2);
    expect(server.events()[0]?.headers?.['sec-websocket-protocol']).toBe('attest.fixture');
  });

  it('completes multiplexed requests out of order while preserving correlation ids', async () => {
    const server = await start('multiplexed_out_of_order');
    const client = await connect(server.url);

    client.send('multiplexed-1');
    client.send('multiplexed-2');
    const messages = await Promise.all([
      jsonMessage(client),
      jsonMessage(client),
      jsonMessage(client),
      jsonMessage(client),
    ]);

    expect(messages.map((message) => [message.type, message.request_id])).toEqual([
      ['acknowledgement', 'multiplexed-1'],
      ['acknowledgement', 'multiplexed-2'],
      ['result', 'multiplexed-2'],
      ['result', 'multiplexed-1'],
    ]);
  });
});

describe('WebSocket fake server acknowledgement boundaries', () => {
  it('acknowledges and then disconnects without a terminal result', async () => {
    const server = await start('ack_then_disconnect');
    const client = await connect(server.url);
    client.send('acknowledged');

    expect(await jsonMessage(client)).toMatchObject({
      request_id: 'acknowledged',
      type: 'acknowledgement',
    });
    expect(await client.waitForClose()).toMatchObject({ code: 1006, wasClean: false });
    expect(server.events().map((event) => event.type)).toContain('forced_close');
  });

  it('disconnects before acknowledgement and permits a fresh connection to succeed', async () => {
    const server = await start('disconnect_before_ack_then_reconnect');
    const firstClient = await connect(server.url);
    firstClient.send('retryable');
    expect(await firstClient.waitForClose()).toMatchObject({ code: 1006 });

    const secondClient = await connect(server.url);
    secondClient.send('retryable');
    expect(await jsonMessage(secondClient)).toMatchObject({
      request_id: 'retryable',
      type: 'acknowledgement',
    });
    expect(await jsonMessage(secondClient)).toMatchObject({
      request_id: 'retryable',
      type: 'result',
    });
    expect(server.events().filter((event) => event.type === 'connection_opened')).toHaveLength(2);
  });
});

describe('WebSocket fake server timing and close scenarios', () => {
  it('observes automatic pong replies and leaves idle connections silent', async () => {
    const pingServer = await start('ping_pong');
    await connect(pingServer.url);
    const pong = await pingServer.waitForEvent((event) => event.type === 'pong_received');
    expect(pong.bytes).toBe(Buffer.byteLength('fixture-ping'));

    const idleServer = await start('idle');
    const idleClient = await connect(idleServer.url);
    await expect(idleClient.nextMessage(50)).rejects.toThrow('Timed out');
    expect(idleServer.events().some((event) => event.type === 'text_sent')).toBe(false);
  });

  it('delays the opening handshake without delaying correlated behavior afterward', async () => {
    const server = await start('delayed_open', { openDelayMs: 60 });
    const client = await connect(server.url);
    const opened = server.events().find((event) => event.type === 'connection_opened');
    expect(opened?.elapsedMs).toBeGreaterThanOrEqual(45);

    client.send('delayed');
    expect(await jsonMessage(client)).toMatchObject({ type: 'acknowledgement' });
    expect(await jsonMessage(client)).toMatchObject({ type: 'result' });
  });

  it('distinguishes graceful close frames from forced transport loss', async () => {
    const gracefulServer = await start('graceful_close');
    const gracefulClient = await connect(gracefulServer.url);
    gracefulClient.send('graceful');
    expect(await gracefulClient.waitForClose()).toEqual({
      code: 1000,
      reason: 'fixture graceful close',
      wasClean: true,
    });

    const forcedServer = await start('forced_close');
    const forcedClient = await connect(forcedServer.url);
    forcedClient.send('forced');
    expect(await forcedClient.waitForClose()).toMatchObject({ code: 1006, wasClean: false });
  });
});

describe('WebSocket fake server hostile message scenarios', () => {
  it('emits malformed JSON, unmatched correlation, and uncorrelated server work separately', async () => {
    const malformedServer = await start('malformed_json');
    const malformedClient = await connect(malformedServer.url);
    malformedClient.send('malformed');
    const malformed = await malformedClient.nextMessage();
    expect(malformed).toBe('{"request_id":');
    if (typeof malformed !== 'string') throw new Error('Expected malformed text JSON.');
    expect(() => {
      JSON.parse(malformed);
    }).toThrow();

    const unmatchedServer = await start('unmatched_json');
    const unmatchedClient = await connect(unmatchedServer.url);
    unmatchedClient.send('expected');
    expect(await jsonMessage(unmatchedClient)).toMatchObject({
      request_id: 'fixture-unmatched',
      type: 'result',
    });

    const uncorrelatedServer = await start('uncorrelated_server_work');
    const uncorrelatedClient = await connect(uncorrelatedServer.url);
    expect(await jsonMessage(uncorrelatedClient)).toEqual({
      type: 'work',
      input: 'server initiated',
    });
  });

  it('emits extended-length text and unsupported binary frames', async () => {
    const oversizedServer = await start('oversized_message', { oversizedMessageBytes: 80_000 });
    const oversizedClient = await connect(oversizedServer.url);
    oversizedClient.send('oversized');
    const oversized = await jsonMessage(oversizedClient);
    expect((oversized.result as string).length).toBe(80_000);
    expect(
      oversizedServer.events().find((event) => event.type === 'text_sent')?.bytes,
    ).toBeGreaterThan(80_000);

    const binaryServer = await start('binary_frame');
    const binaryClient = await connect(binaryServer.url);
    binaryClient.send('binary');
    const binary = await binaryClient.nextMessage();
    expect(binary).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(Buffer.from(binary as ArrayBuffer).toString('utf8'))).toMatchObject({
      request_id: 'binary',
      type: 'result',
    });
  });

  it('provides stable secret-bearing result and trace fields for redaction lanes', async () => {
    const server = await start('secret_bearing_evidence');
    const client = await connect(server.url);
    client.send('secret', { authorization: `Bearer ${SECRET_BEARING_FIXTURE_VALUE}` });

    expect(await jsonMessage(client)).toMatchObject({ type: 'acknowledgement' });
    const evidence = await jsonMessage(client);
    expect(evidence).toMatchObject({
      request_id: 'secret',
      result: {
        authorization: `Bearer ${SECRET_BEARING_FIXTURE_VALUE}`,
        nested: { api_key: SECRET_BEARING_FIXTURE_VALUE },
      },
      trace: { token: SECRET_BEARING_FIXTURE_VALUE },
    });
  });

  it('keeps the public scenario registry exhaustive and duplicate-free', () => {
    expect(new Set(webSocketFixtureScenarioNames).size).toBe(webSocketFixtureScenarioNames.length);
    expect(webSocketFixtureScenarioNames).toHaveLength(15);
  });
});
