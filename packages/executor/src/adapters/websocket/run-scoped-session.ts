import type { AgentRequest, WebSocketErrorClassification } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import { createSerialQueue } from '../../internal/serial-queue.js';
import type { InvocationResult } from '../../types.js';
import type { WebSocketClose, WebSocketConnection } from './websocket-connection.js';
import { beginRetry, type PendingInvocation } from './websocket-evidence.js';
import { errorClassification, type WebSocketAgentResource } from './websocket-protocol.js';
import { WebSocketSessionState, type WebSocketSessionOptions } from './websocket-session-state.js';

/** Connection failures a request may be replayed after, provided it was never acknowledged. */
const RECONNECTABLE = new Set<WebSocketErrorClassification>([
  'connection_failed',
  'handshake_failed',
  'open_timeout',
  'unexpected_close',
]);

/** The shared connection: none, a handshake in flight, or open with its keepalive ping. */
type SharedConnection =
  | { kind: 'idle' }
  | { kind: 'opening'; generation: number; promise: Promise<WebSocketConnection> }
  | { kind: 'open'; generation: number; connection: WebSocketConnection; ping: NodeJS.Timeout };

/**
 * Shares one connection across every case of the run, serially or multiplexed. A lost connection
 * is reopened and unacknowledged requests are replayed on it within the retry budget.
 */
class RunScopedWebSocketSession {
  private readonly state: WebSocketSessionState;
  private readonly runSerially = createSerialQueue();
  private closePromise?: Promise<void>;
  private shared: SharedConnection = { kind: 'idle' };
  /** Generation of the newest handshake; callbacks from older connections are ignored. */
  private connectionGeneration = 0;

  constructor(agent: WebSocketAgentResource, options: WebSocketSessionOptions) {
    this.state = new WebSocketSessionState(agent, options, {
      onRequestTimeout: (pending, error, classification) =>
        void this.retryOrSettle(pending, error, classification),
      onRunEnd: () => this.releaseOpenConnection()?.destroy(),
    });
  }

  invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.state.agent.transport.connection_mode === 'multiplexed') {
      return this.dispatch(request, signal);
    }

    return this.runSerially(() => this.dispatch(request, signal));
  }

  /** Ends the run-scoped lifecycle and guarantees bounded socket cleanup. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.state.beginClose();
    const connection = this.releaseOpenConnection();
    this.closePromise = (async () => {
      if (connection === undefined) return;
      const close = await connection.close(this.state.agent.transport.close_timeout_ms);

      if (!close.clean) {
        throw new AgentInvocationError('timeout', 'WebSocket close handshake timed out.', {
          classification: 'close_timeout',
        });
      }
    })();

    return this.closePromise;
  }

  private dispatch(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    if (this.state.lifecycle.signal.aborted) {
      return Promise.resolve(this.state.closedResult(this.state.createPending(request, signal)));
    }

    return new Promise<InvocationResult>((resolve) => {
      const pending = this.state.createPending(request, signal, resolve);
      this.state.arm(pending);
      void this.sendOnConnection(pending);
    });
  }

  private async sendOnConnection(pending: PendingInvocation): Promise<void> {
    try {
      const connection = await this.ensureConnection();

      if (!this.state.pending.has(pending.requestId)) return;
      await this.state.send(pending, connection, pending.signal);
    } catch (error: unknown) {
      if (!this.state.pending.has(pending.requestId)) return;

      const normalized =
        error instanceof AgentInvocationError
          ? error
          : new AgentInvocationError('network', 'WebSocket connection failed.', { cause: error });

      await this.retryOrSettle(pending, normalized, errorClassification(normalized));
    }
  }

  /** Leaves the open state, stopping its ping, and hands back the connection to dispose of. */
  private releaseOpenConnection(): WebSocketConnection | undefined {
    if (this.shared.kind !== 'open') return undefined;
    const { connection, ping } = this.shared;
    clearInterval(ping);
    this.shared = { kind: 'idle' };

    return connection;
  }

  private ensureConnection(): Promise<WebSocketConnection> {
    if (this.shared.kind === 'open') return Promise.resolve(this.shared.connection);

    if (this.shared.kind === 'opening') return this.shared.promise;
    const generation = ++this.connectionGeneration;
    const { evidence, options } = this.state;

    const runSignal = AbortSignal.any(
      [options.signal, this.state.lifecycle.signal].filter((signal) => signal !== undefined),
    );

    const forEachPending = (record: (pending: PendingInvocation) => void): void => {
      for (const pending of this.state.pending.values()) record(pending);
    };

    const promise = this.state
      .openConnection(runSignal, {
        onClose: (close) => this.connectionLost(generation, close),
        onFailure: (error) => this.connectionFailed(generation, error),
        onPong: () =>
          forEachPending((pending) =>
            evidence.record(pending, { classification: 'pong_received' }),
          ),
        onText: (text, bytes) => this.state.consumeMessage(text, bytes),
      })
      .then(
        (connection) => {
          this.releaseOpenConnection();
          this.shared = {
            kind: 'open',
            generation,
            connection,
            ping: this.startPing(connection),
          };
          forEachPending((pending) =>
            evidence.record(pending, { classification: 'connection_opened' }),
          );

          return connection;
        },
        (cause: unknown) => {
          if (this.shared.kind === 'opening' && this.shared.generation === generation) {
            this.shared = { kind: 'idle' };
          }

          throw cause;
        },
      );

    this.shared = { kind: 'opening', generation, promise };

    return promise;
  }

  private async retryOrSettle(
    pending: PendingInvocation,
    error: AgentInvocationError,
    classification: WebSocketErrorClassification,
  ): Promise<void> {
    const { agent, evidence } = this.state;

    if (!this.state.pending.has(pending.requestId)) return;

    const retryable =
      !pending.acknowledged &&
      pending.retriesUsed < (agent.retry?.retries ?? 0) &&
      (error.code === 'network' || error.code === 'timeout') &&
      RECONNECTABLE.has(classification);

    if (!retryable) {
      this.state.settleFailure(pending, error, classification);

      return;
    }

    pending.attempts.push(evidence.failureAttempt(pending, error, classification));
    pending.retriesUsed += 1;
    beginRetry(pending);
    evidence.record(pending, { classification: 'retry_scheduled' });

    try {
      await abortableWait(
        retryBackoffDelay(agent.retry?.backoff, pending.retriesUsed - 1),
        pending.signal ?? this.state.options.signal,
        () => new AgentInvocationError('cancelled', 'WebSocket retry was cancelled.'),
      );

      if (!this.state.pending.has(pending.requestId)) return;
      evidence.record(pending, { classification: 'reconnect_started' });
      this.state.arm(pending);
      await this.sendOnConnection(pending);
    } catch (waitError: unknown) {
      this.state.settleFailure(
        pending,
        waitError instanceof AgentInvocationError ? waitError : error,
        'cancelled',
      );
    }
  }

  private connectionFailed(generation: number, error: AgentInvocationError): void {
    if (generation !== this.connectionGeneration) return;
    this.releaseOpenConnection()?.destroy();
    this.shared = { kind: 'idle' };

    for (const pending of [...this.state.pending.values()]) {
      void this.retryOrSettle(pending, error, errorClassification(error));
    }
  }

  private connectionLost(generation: number, close: WebSocketClose): void {
    if (this.shared.kind !== 'open' || this.shared.generation !== generation) return;
    this.releaseOpenConnection();

    const error = new AgentInvocationError(
      'network',
      'WebSocket disconnected before requests settled.',
      { classification: 'unexpected_close' },
    );

    for (const pending of [...this.state.pending.values()]) {
      this.state.evidence.recordClose(pending, close);
      void this.retryOrSettle(pending, error, 'unexpected_close');
    }
  }

  private startPing(connection: WebSocketConnection): NodeJS.Timeout {
    return setInterval(() => {
      if (this.shared.kind !== 'open' || this.shared.connection !== connection) return;

      if (!connection.ping()) return;

      for (const pending of this.state.pending.values()) {
        this.state.evidence.record(pending, { classification: 'ping_sent' });
      }
    }, this.state.agent.transport.ping_interval_ms);
  }
}

export { RunScopedWebSocketSession };
