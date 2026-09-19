import type { Duplex } from 'node:stream';

import { AgentInvocationError } from '../../errors.js';
import {
  WebSocketFrameDecoder,
  encodeWebSocketFrame,
  type WebSocketCloseFrame,
} from './websocket-frame.js';
import { openWebSocketHandshake, type ClassifiedWebSocketError } from './websocket-handshake.js';

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

/** Owns one upgraded socket, including bounded frame parsing and the close handshake. */
class WebSocketConnection {
  private closeDetails?: WebSocketClose;
  private closePromise?: Promise<WebSocketClose>;
  private closeResolve?: (close: WebSocketClose) => void;
  private failed = false;
  private readonly frameDecoder: WebSocketFrameDecoder;
  private pendingWriteBytes = 0;
  private receivedClose = false;
  private sentClose = false;
  private readonly writeController = new AbortController();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: Duplex,
    maximumMessageBytes: number,
    private readonly callbacks: WebSocketConnectionCallbacks,
    initialData: Buffer,
    private readonly maximumPendingWriteBytes = maximumMessageBytes,
  ) {
    this.frameDecoder = new WebSocketFrameDecoder(maximumMessageBytes, {
      onClose: (close) => this.acceptClose(close),
      onFailure: (error) => this.fail(error),
      onPing: (payload) => this.writeControlFrame(0x0a, payload),
      onPong: () => {
        if (!this.failed && !this.receivedClose && !this.socket.destroyed) callbacks.onPong();
      },
      onText: (text, bytes) => {
        if (!this.failed && !this.receivedClose && !this.socket.destroyed) {
          callbacks.onText(text, bytes);
        }
      },
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.failed || this.receivedClose || this.socket.destroyed) return;
      this.frameDecoder.accept(chunk);
    });
    socket.once('error', (error) =>
      this.fail(
        new AgentInvocationError('network', 'WebSocket connection failed.', { cause: error }),
      ),
    );
    socket.once('close', () => this.finishClose());
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
    if (this.failed || this.sentClose || this.socket.destroyed || this.socket.writableNeedDrain)
      return false;
    this.socket.write(encodeWebSocketFrame(0x9));
    return true;
  }

  /** Performs a bounded close handshake and destroys sockets that do not cooperate. */
  async close(timeoutMs: number): Promise<WebSocketClose> {
    if (this.closeDetails !== undefined) return this.closeDetails;
    if (this.closePromise === undefined) {
      this.closePromise = new Promise<WebSocketClose>((resolve) => {
        this.closeResolve = resolve;
      });
    }
    this.writeController.abort();
    if (!this.sentClose && !this.socket.destroyed) {
      this.sentClose = true;
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
    const completed = await Promise.race([this.closePromise, timeout]);
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
    if (this.failed || this.sentClose || this.socket.destroyed) {
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
    if (this.failed || this.sentClose || this.socket.destroyed || this.socket.writableNeedDrain)
      return false;
    this.socket.write(encodeWebSocketFrame(opcode, payload));
    return true;
  }

  private acceptClose({ code, payload, reason }: WebSocketCloseFrame): void {
    this.receivedClose = true;
    this.writeController.abort();
    this.closeDetails = {
      clean: this.sentClose || code === 1_000,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 123) }),
    };
    if (!this.sentClose && !this.socket.destroyed) {
      this.sentClose = true;
      this.socket.write(encodeWebSocketFrame(0x8, payload));
    }
    this.socket.end();
  }

  private fail(error: AgentInvocationError): void {
    if (this.failed) return;
    this.failed = true;
    this.writeController.abort();
    this.callbacks.onFailure(error);
    this.socket.destroy();
  }

  private finishClose(): void {
    this.writeController.abort();
    const close = this.closeDetails ?? { clean: this.receivedClose };
    this.closeDetails = close;
    this.closeResolve?.(close);
    this.callbacks.onClose(close);
  }
}

/** Opens a DNS-pinned RFC 6455 connection after validating the URL and handshake. */
const openWebSocket = async (options: OpenWebSocketOptions): Promise<WebSocketConnection> => {
  const { head, socket } = await openWebSocketHandshake(options);
  return new WebSocketConnection(
    socket,
    options.maximumMessageBytes,
    options.callbacks,
    head,
    options.maximumPendingWriteBytes,
  );
};

export {
  WebSocketConnection,
  openWebSocket,
  type ClassifiedWebSocketError,
  type OpenWebSocketOptions,
  type WebSocketClose,
  type WebSocketConnectionCallbacks,
};
