import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

type TestWebSocketServerOptions = {
  ignoreUpgrade?: boolean;
  ignoreClientClose?: boolean;
  onConnection?: (peer: TestWebSocketPeer, request: IncomingMessage) => void;
  onMessage: (peer: TestWebSocketPeer, value: unknown) => void;
  subprotocol?: string;
};

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Encodes one intentionally small server frame for hostile adapter tests. */
const serverFrame = (
  opcode: number,
  payload: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): Buffer<ArrayBufferLike> => {
  if (payload.byteLength > 65_535) throw new Error('test frames must remain small');
  const lengthBytes = payload.byteLength < 126 ? 0 : 2;
  const header = Buffer.alloc(2 + lengthBytes);
  header[0] = 0x80 | opcode;
  if (lengthBytes === 0) {
    header[1] = payload.byteLength;
  } else {
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
  }
  return Buffer.concat([header, payload]);
};

/** Minimal RFC 6455 peer used only by colocated runtime tests. */
class TestWebSocketPeer {
  private buffer = Buffer.alloc(0);
  pingCount = 0;

  constructor(
    private readonly socket: Duplex,
    private readonly onMessage: TestWebSocketServerOptions['onMessage'],
    private readonly ignoreClientClose: boolean,
  ) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendText(value: string): void {
    this.socket.write(serverFrame(0x1, Buffer.from(value, 'utf8')));
  }

  sendBinary(value: Buffer = Buffer.from([1])): void {
    this.socket.write(serverFrame(0x2, value));
  }

  close(code = 1_000, reason = 'complete'): void {
    const reasonBytes = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.byteLength);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.socket.write(serverFrame(0x8, payload));
    this.socket.end();
  }

  drop(): void {
    this.socket.destroy();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.byteLength < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const opcode = first & 0x0f;
      let headerBytes = 2;
      let payloadBytes = second & 0x7f;
      if (payloadBytes === 126) {
        if (this.buffer.byteLength < 4) return;
        payloadBytes = this.buffer.readUInt16BE(2);
        headerBytes = 4;
      } else if (payloadBytes === 127) {
        if (this.buffer.byteLength < 10) return;
        payloadBytes = Number(this.buffer.readBigUInt64BE(2));
        headerBytes = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.byteLength < headerBytes + maskBytes + payloadBytes) return;
      const mask = this.buffer.subarray(headerBytes, headerBytes + maskBytes);
      const source = this.buffer.subarray(
        headerBytes + maskBytes,
        headerBytes + maskBytes + payloadBytes,
      );
      const payload = Buffer.alloc(source.byteLength);
      for (let index = 0; index < source.byteLength; index += 1) {
        payload[index] = masked ? source[index]! ^ mask[index % 4]! : source[index]!;
      }
      this.buffer = this.buffer.subarray(headerBytes + maskBytes + payloadBytes);
      if (opcode === 0x1) {
        this.onMessage(this, JSON.parse(payload.toString('utf8')) as unknown);
      } else if (opcode === 0x8 && !this.ignoreClientClose) {
        this.socket.write(serverFrame(0x8, payload));
        this.socket.end();
      } else if (opcode === 0x9) {
        this.pingCount += 1;
        this.socket.write(serverFrame(0x0a, payload));
      }
    }
  }
}

/** Starts an isolated loopback WebSocket fixture without third-party protocol dependencies. */
const startTestWebSocketServer = async (
  options: TestWebSocketServerOptions,
): Promise<{
  close: () => Promise<void>;
  connectionCount: () => number;
  peers: TestWebSocketPeer[];
  url: string;
}> => {
  const peers: TestWebSocketPeer[] = [];
  const sockets = new Set<Duplex>();
  const server: Server = createServer((_request, response) => {
    response.writeHead(426).end();
  });
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (options.ignoreUpgrade === true) return;
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(options.subprotocol === undefined
          ? []
          : [`Sec-WebSocket-Protocol: ${options.subprotocol}`]),
        '',
        '',
      ].join('\r\n'),
    );
    const peer = new TestWebSocketPeer(
      socket,
      options.onMessage,
      options.ignoreClientClose === true,
    );
    peers.push(peer);
    options.onConnection?.(peer, request);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP');
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
    connectionCount: () => peers.length,
    peers,
    url: `ws://127.0.0.1:${String(address.port)}`,
  };
};

export { TestWebSocketPeer, startTestWebSocketServer, type TestWebSocketServerOptions };
