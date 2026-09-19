import { Duplex } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { WebSocketConnection, type WebSocketConnectionCallbacks } from '../websocket-connection.js';

/** Provides deterministic writable backpressure and direct server-frame injection. */
class ControlledSocket extends Duplex {
  readonly writes: Buffer[] = [];
  private readonly writeCallbacks: Array<(error?: Error | null) => void> = [];

  constructor() {
    super({ readableHighWaterMark: 16, writableHighWaterMark: 16 });
  }

  override _read(): void {
    // Tests inject server bytes explicitly through `receive`.
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    this.writeCallbacks.push(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    for (const complete of this.writeCallbacks.splice(0)) complete();
    callback(error);
  }

  /** Releases one blocked write so Node emits the corresponding drain edge. */
  releaseWrite(): void {
    this.writeCallbacks.shift()?.();
  }

  /** Delivers one unmasked server frame to the connection parser. */
  receive(frame: Buffer): void {
    this.emit('data', frame);
  }
}

/** Encodes a small unmasked server frame for parser boundary tests. */
const serverFrame = (opcode: number, final: boolean, text: string): Buffer => {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([(final ? 0x80 : 0) | opcode, payload.byteLength]), payload]);
};

/** Creates callbacks that expose terminal parser behavior without adapter indirection. */
const callbacks = (
  texts: string[],
  failures: Array<{ code: string }>,
): WebSocketConnectionCallbacks => ({
  onClose: () => undefined,
  onFailure: (error) => failures.push(error),
  onPong: () => undefined,
  onText: (text) => texts.push(text),
});

/** Lets a queued promise advance to its next stream operation. */
const advance = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('WebSocket connection bounds', () => {
  it('enforces the aggregate message cap on the final continuation frame', () => {
    const boundarySocket = new ControlledSocket();
    const boundaryTexts: string[] = [];
    const boundaryFailures: Array<{ code: string }> = [];
    new WebSocketConnection(
      boundarySocket,
      10,
      callbacks(boundaryTexts, boundaryFailures),
      Buffer.alloc(0),
    );
    boundarySocket.receive(serverFrame(0x1, false, '123456'));
    boundarySocket.receive(serverFrame(0x0, true, '7890'));
    expect(boundaryTexts).toEqual(['1234567890']);
    expect(boundaryFailures).toEqual([]);

    const oversizedSocket = new ControlledSocket();
    const oversizedTexts: string[] = [];
    const oversizedFailures: Array<{ code: string }> = [];
    new WebSocketConnection(
      oversizedSocket,
      10,
      callbacks(oversizedTexts, oversizedFailures),
      Buffer.alloc(0),
    );
    oversizedSocket.receive(serverFrame(0x1, false, '123456'));
    oversizedSocket.receive(serverFrame(0x0, true, '78901'));
    expect(oversizedTexts).toEqual([]);
    expect(oversizedFailures).toMatchObject([{ code: 'output_cap_exceeded' }]);
    expect(oversizedSocket.destroyed).toBe(true);
  });

  it('serializes writes and interrupts drain waits on cancellation and close', async () => {
    const serializedSocket = new ControlledSocket();
    const connection = new WebSocketConnection(
      serializedSocket,
      1_024,
      callbacks([], []),
      Buffer.alloc(0),
      1_024,
    );
    const first = connection.sendText('a'.repeat(64));
    const second = connection.sendText('b'.repeat(32));
    await advance();
    expect(serializedSocket.writes).toHaveLength(1);
    serializedSocket.releaseWrite();
    await first;
    await advance();
    expect(serializedSocket.writes).toHaveLength(2);
    serializedSocket.releaseWrite();
    await second;
    connection.destroy();

    const cancellationSocket = new ControlledSocket();
    const cancellable = new WebSocketConnection(
      cancellationSocket,
      1_024,
      callbacks([], []),
      Buffer.alloc(0),
      1_024,
    );
    const controller = new AbortController();
    const cancelledWrite = cancellable.sendText('c'.repeat(64), controller.signal);
    await advance();
    expect(cancellationSocket.writes).toHaveLength(1);
    controller.abort();
    await expect(cancelledWrite).rejects.toMatchObject({ code: 'cancelled' });
    cancellable.destroy();

    const closingSocket = new ControlledSocket();
    const closing = new WebSocketConnection(
      closingSocket,
      1_024,
      callbacks([], []),
      Buffer.alloc(0),
      1_024,
    );
    const interruptedWrite = closing.sendText('d'.repeat(64));
    await advance();
    const close = closing.close(10);
    await expect(interruptedWrite).rejects.toMatchObject({ code: 'cancelled' });
    await expect(close).resolves.toEqual({ clean: false });
    expect(closingSocket.destroyed).toBe(true);
  });
});
