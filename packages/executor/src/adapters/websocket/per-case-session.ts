import type { AgentRequest } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import type { WebSocketConnection } from './websocket-connection.js';
import {
  clearPendingTimers,
  createPendingInvocation,
  type PendingInvocation,
} from './websocket-evidence.js';
import { errorClassification, type WebSocketAgentResource } from './websocket-protocol.js';
import { WebSocketSessionState, type WebSocketSessionOptions } from './websocket-session-state.js';

/** Waits for retry backoff while keeping caller cancellation immediate. */
const waitForRetry = (delayMs: number, signal: AbortSignal | undefined): Promise<void> =>
  abortableWait(
    delayMs,
    signal,
    () => new AgentInvocationError('cancelled', 'WebSocket retry was cancelled.'),
  );

/**
 * Opens a fresh connection for every case and closes it once the case settles. A failed attempt
 * that was never acknowledged is retried on a new connection.
 */
class PerCaseWebSocketSession {
  private readonly state: WebSocketSessionState;
  private closePromise?: Promise<void>;

  constructor(agent: WebSocketAgentResource, options: WebSocketSessionOptions) {
    this.state = new WebSocketSessionState(agent, options, {
      // Each attempt owns its connection, so a deadline ends the attempt; invoke decides retries.
      onRequestTimeout: (pending, error, classification) =>
        this.state.settleFailure(pending, error, classification),
      onRunEnd: () => undefined,
    });
  }

  async invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
    const { agent } = this.state;
    const attempts: InvocationAttempt[] = [];
    for (let retry = 0; ; retry += 1) {
      const pending = this.state.createPending(request, signal);
      const result = await this.runAttempt(pending);
      // Acknowledged work may already be running remotely, so it is never replayed.
      const retryable =
        result.status === 'invocation_error' &&
        !pending.acknowledged &&
        retry < (agent.retry?.retries ?? 0) &&
        (result.error.code === 'network' || result.error.code === 'timeout');
      if (!retryable) return { ...result, attempts: [...attempts, ...result.attempts] };
      attempts.push(...result.attempts);
      try {
        await waitForRetry(retryBackoffDelay(agent.retry?.backoff, retry), signal);
      } catch (error: unknown) {
        // The interrupted wait is recorded against the last attempt's request id.
        return this.state.evidence.failureResult(
          createPendingInvocation(request, pending.requestId, () => undefined, signal),
          error instanceof AgentInvocationError ? error : result.error,
          'cancelled',
          attempts,
        );
      }
    }
  }

  /** Ends the session and cancels outstanding cases; their connections close themselves. */
  close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.state.beginClose();
      this.closePromise = Promise.resolve();
    }
    return this.closePromise;
  }

  /** Runs one request on its own connection, including the close handshake. */
  private async runAttempt(pending: PendingInvocation): Promise<InvocationResult> {
    const { agent, evidence } = this.state;
    const { requestId, signal } = pending;
    if (this.state.closed) return this.state.closedResult(pending);
    const result = new Promise<InvocationResult>((resolve) => {
      pending.resolve = resolve;
    });
    let connection: WebSocketConnection | undefined;
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([
      attemptController.signal,
      this.state.lifecycle.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const lose = (error: AgentInvocationError): void =>
      this.state.settleFailure(pending, error, errorClassification(error));
    this.state.arm(pending);
    try {
      connection = await this.state.openConnection(attemptSignal, {
        onClose: (close) => {
          evidence.recordClose(pending, close);
          lose(
            new AgentInvocationError('network', 'WebSocket closed before a terminal response.', {
              classification: 'unexpected_close',
            }),
          );
        },
        onFailure: lose,
        onPong: () => evidence.record(pending, { classification: 'pong_received' }),
        onText: (text, bytes) => this.state.consumeMessage(text, bytes, new Set([requestId])),
      });
      // Closing a session can settle the invocation while an HTTP upgrade is still racing.
      if (this.state.closed || attemptSignal.aborted || !this.state.pending.has(requestId)) {
        connection.destroy();
        return await result;
      }
      pending.connection = connection;
      evidence.record(pending, { classification: 'connection_opened' });
      await this.state.send(pending, connection, attemptSignal);
      const terminal = await result;
      const close = await connection.close(agent.transport.close_timeout_ms);
      evidence.recordClose(pending, close);
      if (!close.clean && terminal.status === 'ok') {
        return evidence.failureResult(
          pending,
          new AgentInvocationError('timeout', 'WebSocket close handshake timed out.', {
            classification: 'close_timeout',
          }),
          'close_timeout',
          terminal.attempts.slice(0, -1),
        );
      }
      return terminal;
    } catch (error: unknown) {
      lose(
        error instanceof AgentInvocationError
          ? error
          : new AgentInvocationError('network', 'WebSocket connection failed.', { cause: error }),
      );
      return await result;
    } finally {
      attemptController.abort();
      connection?.destroy();
      this.state.pending.delete(requestId);
      clearPendingTimers(pending);
    }
  }
}

export { PerCaseWebSocketSession };
