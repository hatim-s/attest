import * as Effect from 'effect/Effect';
import * as Semaphore from 'effect/Semaphore';
import type { Duplex } from 'node:stream';

import { AgentInvocationError } from '../../errors.js';
import {
  WebSocketFrameDecoder,
  encodeWebSocketFrame,
  type WebSocketCloseFrame,
} from './websocket-frame.js';
import { openWebSocketHandshake } from './websocket-handshake.js';

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
  maximumPendingWriteBytes: number;
  openTimeoutMs: number;
  secrets: readonly string[];
  signal: AbortSignal;
  subprotocol?: string;
  url: string;
};

type WebSocketConnectionOptions = {
  socket: Duplex;
  /** Bytes the server sent after the upgrade response, already part of the frame stream. */
  initialData: Buffer;
  callbacks: WebSocketConnectionCallbacks;
  maximumMessageBytes: number;
  maximumPendingWriteBytes: number;
};

/**
 * Close handshake progress. `closing` means attest sent its close frame; `received` means the peer's
 * close frame arrived and was answered; `closed` means the socket is gone. A failure after the
 * peer's close frame keeps that frame's details.
 */
type ConnectionState =
  | { kind: 'open' }
  | { kind: 'closing' }
  | { kind: 'received'; close: WebSocketClose }
  | { kind: 'failed'; close?: WebSocketClose }
  | { kind: 'closed'; close: WebSocketClose };

/** Owns one upgraded socket, including bounded frame parsing and the close handshake. */
class WebSocketConnection {
  private state: ConnectionState = { kind: 'open' };
  /** Settles when the socket closes, with the details of the close handshake. */
  private readonly closeObservers = new Set<(close: WebSocketClose) => void>();
  private readonly frameDecoder: WebSocketFrameDecoder;
  private pendingWriteBytes = 0;
  private readonly writeController = new AbortController();
  private readonly writes = Semaphore.makeUnsafe(1);

  private readonly socket: Duplex;
  private readonly callbacks: WebSocketConnectionCallbacks;
  private readonly maximumPendingWriteBytes: number;

  constructor(options: WebSocketConnectionOptions) {
    const { callbacks, initialData, socket } = options;
    this.socket = socket;
    this.callbacks = callbacks;
    this.maximumPendingWriteBytes = options.maximumPendingWriteBytes;
    this.frameDecoder = new WebSocketFrameDecoder(options.maximumMessageBytes, {
      onClose: (close) => this.acceptClose(close),
      onFailure: (error) => this.fail(error),
      onPing: (payload) => this.writeControlFrame(0x0a, payload),
      onPong: () => {
        if (this.readable()) callbacks.onPong();
      },
      onText: (text, bytes) => {
        if (this.readable()) callbacks.onText(text, bytes);
      },
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.readable()) this.frameDecoder.accept(chunk);
    });
    socket.once('error', (error) =>
      this.fail(
        new AgentInvocationError('network', 'WebSocket connection failed.', { cause: error }),
      ),
    );
    socket.once('close', () => {
      const close = this.finishClose();

      for (const observe of this.closeObservers) observe(close);
      this.closeObservers.clear();
    });

    if (initialData.byteLength > 0) this.frameDecoder.accept(initialData);
  }

  /** Serializes one bounded text-JSON message and waits for socket backpressure to clear. */
  sendText(text: string, signal?: AbortSignal): Effect.Effect<void, AgentInvocationError> {
    return Effect.suspend(() => {
      const payload = Buffer.from(text, 'utf8');

      if (this.pendingWriteBytes + payload.byteLength > this.maximumPendingWriteBytes) {
        return Effect.fail(
          new AgentInvocationError(
            'output_cap_exceeded',
            `WebSocket pending writes exceed the ${this.maximumPendingWriteBytes}-byte request cap.`,
          ),
        );
      }

      this.pendingWriteBytes += payload.byteLength;

      const writeSignal =
        signal === undefined
          ? this.writeController.signal
          : AbortSignal.any([signal, this.writeController.signal]);

      return this.writes
        .withPermit(this.writeFrame(encodeWebSocketFrame(0x1, payload), writeSignal))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.pendingWriteBytes -= payload.byteLength;
            }),
          ),
        );
    });
  }

  /** Sends a protocol ping without altering application-idle state. */
  ping(): boolean {
    return this.writeControlFrame(0x9);
  }

  /** Performs a bounded close handshake and destroys sockets that do not cooperate. */
  close(timeoutMs: number): Effect.Effect<WebSocketClose> {
    return Effect.callback((resume) => {
      if (this.state.kind === 'closed') {
        resume(Effect.succeed(this.state.close));

        return;
      }

      this.writeController.abort();

      let destroyedTimer: NodeJS.Timeout | undefined;

      const observe = (close: WebSocketClose): void => {
        clearTimeout(timer);
        clearTimeout(destroyedTimer);
        this.closeObservers.delete(observe);
        resume(Effect.succeed(close));
      };

      const timer = setTimeout(() => {
        this.socket.destroy();
        // A missing close edge is unconfirmed release, never permission to reuse.
        destroyedTimer = setTimeout(() => observe({ clean: false }), timeoutMs);
      }, timeoutMs);

      this.closeObservers.add(observe);

      if (this.state.kind === 'open' && !this.socket.destroyed) {
        this.state = { kind: 'closing' };
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1_000, 0);
        this.socket.write(encodeWebSocketFrame(0x8, payload));
      }

      return Effect.sync(() => {
        clearTimeout(timer);
        clearTimeout(destroyedTimer);
        this.closeObservers.delete(observe);
      });
    });
  }

  /** Immediately releases the socket when a run is cancelled or a protocol violation occurs. */
  destroy(): void {
    this.writeController.abort();
    this.socket.destroy();
  }

  /** Writes a queued application frame only when the stream can accept more bytes. */
  private writeFrame(
    frame: Buffer,
    signal: AbortSignal,
  ): Effect.Effect<void, AgentInvocationError> {
    return Effect.gen({ self: this }, function* () {
      if (signal.aborted)
        return yield* Effect.fail(
          new AgentInvocationError('cancelled', 'WebSocket write was cancelled.'),
        );

      if (!this.writable())
        return yield* Effect.fail(
          new AgentInvocationError('network', 'WebSocket connection is not writable.'),
        );

      if (this.socket.writableNeedDrain) yield* this.waitForDrain(signal);

      if (!this.socket.write(frame)) yield* this.waitForDrain(signal);
    });
  }

  /** Observes the foreign socket drain edge and detaches every listener on exit. */
  private waitForDrain(signal: AbortSignal): Effect.Effect<void, AgentInvocationError> {
    return Effect.callback((resume) => {
      const settle = (result: Effect.Effect<void, AgentInvocationError>): void => {
        detach();
        resume(result);
      };

      const drained = (): void => settle(Effect.void);

      const closed = (): void =>
        settle(
          Effect.fail(
            new AgentInvocationError('network', 'WebSocket connection closed during a write.'),
          ),
        );

      const aborted = (): void =>
        settle(
          Effect.fail(new AgentInvocationError('cancelled', 'WebSocket write was cancelled.')),
        );

      const detach = (): void => {
        this.socket.off('drain', drained);
        this.socket.off('close', closed);
        signal.removeEventListener('abort', aborted);
      };

      this.socket.once('drain', drained);
      this.socket.once('close', closed);
      signal.addEventListener('abort', aborted, { once: true });

      if (signal.aborted) aborted();
      else if (this.socket.destroyed) closed();

      return Effect.sync(detach);
    });
  }

  /** Emits a bounded control frame only when it will not deepen socket backpressure. */
  private writeControlFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): boolean {
    if (!this.writable() || this.socket.writableNeedDrain) return false;
    this.socket.write(encodeWebSocketFrame(opcode, payload));

    return true;
  }

  /** Inbound frames count only while the peer has not closed and nothing has failed. */
  private readable(): boolean {
    return (this.state.kind === 'open' || this.state.kind === 'closing') && !this.socket.destroyed;
  }

  /** Outbound frames are allowed only before either side starts the close handshake. */
  private writable(): boolean {
    return this.state.kind === 'open' && !this.socket.destroyed;
  }

  private acceptClose({ code, payload, reason }: WebSocketCloseFrame): void {
    const sentClose = this.state.kind === 'closing';
    this.writeController.abort();
    const close: WebSocketClose = { clean: sentClose || code === 1_000 };

    if (code !== undefined) close.code = code;

    if (reason !== undefined) close.reason = reason.slice(0, 123);

    if (!sentClose && !this.socket.destroyed) {
      this.socket.write(encodeWebSocketFrame(0x8, payload));
    }

    this.state = { kind: 'received', close };
    this.socket.end();
  }

  private fail(error: AgentInvocationError): void {
    if (this.state.kind === 'failed') return;
    this.state =
      this.state.kind === 'received'
        ? { kind: 'failed', close: this.state.close }
        : { kind: 'failed' };
    this.writeController.abort();
    this.callbacks.onFailure(error);
    this.socket.destroy();
  }

  private finishClose(): WebSocketClose {
    this.writeController.abort();

    const close =
      this.state.kind === 'open' || this.state.kind === 'closing'
        ? { clean: false }
        : (this.state.close ?? { clean: false });

    this.state = { kind: 'closed', close };
    this.callbacks.onClose(close);

    return close;
  }
}

/** Opens a DNS-pinned RFC 6455 connection after validating the URL and handshake. */
const openWebSocket = Effect.fn('openWebSocket')(function* (options: OpenWebSocketOptions) {
  const { head, socket } = yield* openWebSocketHandshake(options);

  return new WebSocketConnection({
    socket,
    initialData: head,
    callbacks: options.callbacks,
    maximumMessageBytes: options.maximumMessageBytes,
    maximumPendingWriteBytes: options.maximumPendingWriteBytes,
  });
});

export {
  WebSocketConnection,
  openWebSocket,
  type WebSocketClose,
  type WebSocketConnectionCallbacks,
};
