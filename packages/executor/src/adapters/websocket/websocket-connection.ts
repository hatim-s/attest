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
  private readonly closed: Promise<WebSocketClose>;
  private readonly frameDecoder: WebSocketFrameDecoder;
  private pendingWriteBytes = 0;
  private readonly writeController = new AbortController();
  private writeTail: Promise<void> = Promise.resolve();

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
    this.closed = new Promise((resolve) => socket.once('close', () => resolve(this.finishClose())));

    if (initialData.byteLength > 0) this.frameDecoder.accept(initialData);
  }

  /** Serializes one bounded text-JSON message and waits for socket backpressure to clear. */
  async sendText(text: string, signal?: AbortSignal): Promise<void> {
    const payload = Buffer.from(text, 'utf8');

    if (this.pendingWriteBytes + payload.byteLength > this.maximumPendingWriteBytes) {
      throw new AgentInvocationError(
        'output_cap_exceeded',
        `WebSocket pending writes exceed the ${this.maximumPendingWriteBytes}-byte request cap.`,
      );
    }

    this.pendingWriteBytes += payload.byteLength;

    const writeSignal =
      signal === undefined
        ? this.writeController.signal
        : AbortSignal.any([signal, this.writeController.signal]);

    const operation = this.writeTail.then(() =>
      this.writeFrame(encodeWebSocketFrame(0x1, payload), writeSignal),
    );

    // A rejected write must not poison later queue bookkeeping or become an unhandled rejection.
    this.writeTail = operation.catch(() => undefined);

    try {
      await operation;
    } finally {
      this.pendingWriteBytes -= payload.byteLength;
    }
  }

  /** Sends a protocol ping without altering application-idle state. */
  ping(): boolean {
    return this.writeControlFrame(0x9);
  }

  /** Performs a bounded close handshake and destroys sockets that do not cooperate. */
  async close(timeoutMs: number): Promise<WebSocketClose> {
    if (this.state.kind === 'received' || this.state.kind === 'closed') return this.state.close;

    this.writeController.abort();

    if (this.state.kind === 'open' && !this.socket.destroyed) {
      this.state = { kind: 'closing' };
      const reason = Buffer.from('complete', 'utf8');
      const payload = Buffer.allocUnsafe(2 + reason.byteLength);
      payload.writeUInt16BE(1_000, 0);
      reason.copy(payload, 2);
      this.socket.write(encodeWebSocketFrame(0x8, payload));
    }

    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<WebSocketClose>((resolve) => {
      timer = setTimeout(() => {
        this.socket.destroy();
        resolve({ clean: false });
      }, timeoutMs);
    });

    const completed = await Promise.race([this.closed, timeout]);

    if (timer !== undefined) clearTimeout(timer);

    return completed;
  }

  /** Immediately releases the socket when a run is cancelled or a protocol violation occurs. */
  destroy(): void {
    this.writeController.abort();
    this.socket.destroy();
  }

  /** Writes a queued application frame only when the stream can accept more bytes. */
  private async writeFrame(frame: Buffer, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new AgentInvocationError('cancelled', 'WebSocket write was cancelled.');
    }

    if (!this.writable()) {
      throw new AgentInvocationError('network', 'WebSocket connection is not writable.');
    }

    if (this.socket.writableNeedDrain) await this.waitForDrain(signal);

    if (!this.socket.write(frame)) await this.waitForDrain(signal);
  }

  /** Waits for one drain edge while close, cancellation, and transport loss stay interruptible. */
  private waitForDrain(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(
        new AgentInvocationError('cancelled', 'WebSocket write was cancelled.'),
      );
    }

    if (this.socket.destroyed) {
      return Promise.reject(
        new AgentInvocationError('network', 'WebSocket connection closed during a write.'),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.socket.off('drain', drained);
        this.socket.off('close', closed);
        signal.removeEventListener('abort', aborted);
      };

      const drained = (): void => {
        cleanup();
        resolve();
      };

      const closed = (): void => {
        cleanup();
        reject(new AgentInvocationError('network', 'WebSocket connection closed during a write.'));
      };

      const aborted = (): void => {
        cleanup();
        reject(new AgentInvocationError('cancelled', 'WebSocket write was cancelled.'));
      };

      this.socket.once('drain', drained);
      this.socket.once('close', closed);
      signal.addEventListener('abort', aborted, { once: true });

      if (signal.aborted) aborted();
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
const openWebSocket = async (options: OpenWebSocketOptions): Promise<WebSocketConnection> => {
  const { head, socket } = await openWebSocketHandshake(options);

  return new WebSocketConnection({
    socket,
    initialData: head,
    callbacks: options.callbacks,
    maximumMessageBytes: options.maximumMessageBytes,
    maximumPendingWriteBytes: options.maximumPendingWriteBytes,
  });
};

export {
  WebSocketConnection,
  openWebSocket,
  type WebSocketClose,
  type WebSocketConnectionCallbacks,
};
