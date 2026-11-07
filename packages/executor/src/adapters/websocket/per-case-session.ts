import type { AgentRequest } from '@attest/contracts';
import type * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import { AgentInvocationError } from '../../errors.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import type { WebSocketConnection } from './websocket-connection.js';
import { clearPendingTimers, type PendingInvocation } from './websocket-evidence.js';
import {
  withWebSocketRelease,
  retainWebSocketOpeningCause,
  retainWebSocketOpeningResult,
  WebSocketCleanupError,
  waitForWebSocketRetry,
} from './websocket-lifetime.js';
import { errorClassification, type WebSocketAgentResource } from './websocket-protocol.js';
import { WebSocketSessionState, type WebSocketSessionOptions } from './websocket-session-state.js';

/** Owns each case socket until its result and bounded release have both been observed. */
class PerCaseWebSocketSession {
  private readonly state: WebSocketSessionState;

  constructor(agent: WebSocketAgentResource, options: WebSocketSessionOptions) {
    this.state = new WebSocketSessionState(agent, options, {
      onRequestTimeout: (pending, error, classification) =>
        this.state.settleFailure(pending, error, classification),
      onRunEnd: () => undefined,
    });
  }

  /** Runs one isolated request. Uncertain dispatch is never replayed. */
  invoke(
    request: AgentRequest,
    signal?: AbortSignal,
  ): Effect.Effect<InvocationResult, AgentInvocationError> {
    return Effect.gen({ self: this }, function* () {
      const attempts: InvocationAttempt[] = [];

      for (let retry = 0; ; retry++) {
        const pending = this.state.createPending(request, signal);

        const result = yield* this.runAttempt(pending).pipe(
          Effect.catch((error) => {
            if (!(error instanceof WebSocketCleanupError)) return Effect.fail(error);

            // Cleanup ends retrying, but earlier refused opens still belong to this invocation.
            return Effect.fail(
              new WebSocketCleanupError(
                { ...error.result, attempts: [...attempts, ...error.result.attempts] },
                error.cleanupCause,
              ),
            );
          }),
        );

        const combined = { ...result, attempts: [...attempts, ...result.attempts] };

        if (
          result.status !== 'invocation_error' ||
          pending.dispatched ||
          pending.acknowledged ||
          result.error.applicationStarted === true ||
          (result.error.code !== 'network' && result.error.code !== 'timeout') ||
          this.state.lifecycle.signal.aborted ||
          retry >= (this.state.agent.retry?.retries ?? 0)
        )
          return combined;
        attempts.push(...result.attempts);

        const retrySignal = AbortSignal.any([
          this.state.lifecycle.signal,
          ...(signal === undefined ? [] : [signal]),
        ]);

        yield* waitForWebSocketRetry(
          retryBackoffDelay(this.state.agent.retry?.backoff, retry),
          retrySignal,
        );

        if (retrySignal.aborted)
          return this.state.evidence.failureResult(
            this.state.createPending(request, signal),
            new AgentInvocationError('cancelled', 'WebSocket retry was cancelled.'),
            'cancelled',
            attempts,
          );
      }
    });
  }

  /** Stops admission; the session owner joins all invocations before releasing its scope. */
  close(): Effect.Effect<void> {
    return Effect.sync(() => this.state.beginClose());
  }

  /** Converts socket observations into case evidence before running release. */
  private runAttempt(
    pending: PendingInvocation,
  ): Effect.Effect<InvocationResult, AgentInvocationError> {
    return Effect.suspend(() => {
      const { agent, evidence } = this.state;

      if (this.state.lifecycle.signal.aborted || this.state.options.signal?.aborted === true)
        return Effect.succeed(this.state.closedResult(pending));
      const terminal = Deferred.makeUnsafe<InvocationResult>();
      const controller = new AbortController();
      pending.resolve = (result) => {
        controller.abort();
        Deferred.doneUnsafe(terminal, Effect.succeed(result));
      };

      const signal = AbortSignal.any([
        controller.signal,
        this.state.lifecycle.signal,
        ...(pending.signal === undefined ? [] : [pending.signal]),
      ]);

      let connection: WebSocketConnection | undefined;
      let openingCause: Cause.Cause<AgentInvocationError> | undefined;

      const lose = (error: AgentInvocationError): void =>
        this.state.settleFailure(pending, error, errorClassification(error));

      const primary = Effect.gen({ self: this }, function* () {
        this.state.arm(pending);

        const opened = yield* Effect.exit(
          this.state.openConnection(signal, {
            onClose: (close) => {
              evidence.recordClose(pending, close);
              lose(
                new AgentInvocationError(
                  'network',
                  'WebSocket closed before a terminal response.',
                  { classification: 'unexpected_close' },
                ),
              );
            },
            onFailure: lose,
            onPong: () => evidence.record(pending, { classification: 'pong_received' }),
            onText: (text, bytes) =>
              this.state.consumeMessage(text, bytes, new Set([pending.requestId])),
          }),
        );

        if (Exit.isFailure(opened)) {
          // flip extracts only typed failures; native defects and interruption still propagate.
          openingCause = opened.cause;

          const error = retainWebSocketOpeningCause(
            yield* Effect.flip(Effect.failCause(opened.cause)),
            openingCause,
          );

          pending.dispatched ||= error.applicationStarted === true;
          lose(error);
        } else {
          connection = opened.value;
          pending.connection = connection;

          if (this.state.pending.has(pending.requestId) && !signal.aborted) {
            evidence.record(pending, { classification: 'connection_opened' });
            yield* this.state
              .send(pending, connection, signal)
              .pipe(Effect.catch((error) => Effect.sync(() => lose(error))));
          } else connection.destroy();
        }

        const result = yield* Deferred.await(terminal);

        return retainWebSocketOpeningResult(result, openingCause);
      });

      const release = Effect.gen({ self: this }, function* () {
        controller.abort();
        this.state.pending.delete(pending.requestId);
        clearPendingTimers(pending);

        if (connection === undefined) return;
        const close = yield* connection.close(agent.transport.close_timeout_ms);
        evidence.recordClose(pending, close);

        if (!close.clean)
          return yield* Effect.fail(
            new AgentInvocationError('timeout', 'WebSocket close handshake timed out.', {
              classification: 'close_timeout',
            }),
          );
      });

      return withWebSocketRelease(
        primary,
        release,
        (result, cause) => new WebSocketCleanupError(result, cause),
      );
    });
  }
}

export { PerCaseWebSocketSession };
