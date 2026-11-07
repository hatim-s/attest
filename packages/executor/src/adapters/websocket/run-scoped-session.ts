import type { AgentRequest } from '@attest/contracts';
import type * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Semaphore from 'effect/Semaphore';

import { AgentInvocationError } from '../../errors.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationResult } from '../../types.js';
import type { WebSocketConnection } from './websocket-connection.js';
import {
  waitForWebSocketRetry,
  retainWebSocketOpeningCause,
  retainWebSocketOpeningResult,
} from './websocket-lifetime.js';
import { beginRetry } from './websocket-evidence.js';
import { errorClassification, type WebSocketAgentResource } from './websocket-protocol.js';
import { WebSocketSessionState, type WebSocketSessionOptions } from './websocket-session-state.js';

/** Shares one generation of a socket while each invocation owns its own terminal observation. */
class RunScopedWebSocketSession {
  private readonly state: WebSocketSessionState;
  private readonly opening = Semaphore.makeUnsafe(1);
  private readonly serial = Semaphore.makeUnsafe(1);
  private connection?: WebSocketConnection;
  private ping?: NodeJS.Timeout;
  private generation = 0;

  constructor(agent: WebSocketAgentResource, options: WebSocketSessionOptions) {
    this.state = new WebSocketSessionState(agent, options, {
      onRequestTimeout: (pending, error, classification) =>
        this.state.settleFailure(pending, error, classification),
      onRunEnd: () => this.connection?.destroy(),
    });
  }

  /** Serial mode queues admission; multiplexed mode keeps sibling cancellation independent. */
  invoke(
    request: AgentRequest,
    signal?: AbortSignal,
  ): Effect.Effect<InvocationResult, AgentInvocationError> {
    const invocation = this.dispatch(request, signal);

    return this.state.agent.transport.connection_mode === 'multiplexed'
      ? invocation
      : this.serial.withPermit(invocation);
  }

  /** Stops admission, joins any handshake, and observes bounded socket release. */
  close(): Effect.Effect<void, AgentInvocationError> {
    return Effect.gen({ self: this }, function* () {
      this.state.beginClose();
      yield* this.opening.withPermit(
        Effect.gen({ self: this }, function* () {
          clearInterval(this.ping);
          const connection = this.connection;
          this.connection = undefined;

          if (connection === undefined) return;
          const close = yield* connection.close(this.state.agent.transport.close_timeout_ms);

          if (!close.clean)
            return yield* Effect.fail(
              new AgentInvocationError('timeout', 'WebSocket close handshake timed out.', {
                classification: 'close_timeout',
              }),
            );
        }),
      );
    });
  }

  /** Only known opening failures can retry; a socket write prohibits replay even without ack. */
  private dispatch(
    request: AgentRequest,
    signal?: AbortSignal,
  ): Effect.Effect<InvocationResult, AgentInvocationError> {
    return Effect.gen({ self: this }, function* () {
      const pending = this.state.createPending(request, signal);

      if (this.state.lifecycle.signal.aborted || this.state.options.signal?.aborted === true)
        return this.state.closedResult(pending);
      const terminal = Deferred.makeUnsafe<InvocationResult>();
      const writeController = new AbortController();

      const writeSignal = AbortSignal.any([
        writeController.signal,
        this.state.lifecycle.signal,
        ...(signal === undefined ? [] : [signal]),
      ]);

      pending.resolve = (result) => {
        writeController.abort();
        Deferred.doneUnsafe(terminal, Effect.succeed(result));
      };

      let openingCause: Cause.Cause<AgentInvocationError> | undefined;

      const work = Effect.gen({ self: this }, function* () {
        this.state.arm(pending);

        for (let retry = 0; ; retry++) {
          const opened = yield* Effect.exit(this.ensureConnection());

          if (Exit.isSuccess(opened)) {
            openingCause = undefined;

            if (this.state.pending.has(pending.requestId)) {
              yield* this.state
                .send(pending, opened.value, writeSignal)
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      this.state.settleFailure(pending, error, errorClassification(error)),
                    ),
                  ),
                );
            }

            break;
          }

          openingCause = opened.cause;

          const error = retainWebSocketOpeningCause(
            yield* Effect.flip(Effect.failCause(opened.cause)),
            openingCause,
          );

          pending.dispatched ||= error.applicationStarted === true;

          if (!this.state.pending.has(pending.requestId)) break;

          if (
            retry >= (this.state.agent.retry?.retries ?? 0) ||
            error.applicationStarted === true ||
            (error.code !== 'network' && error.code !== 'timeout')
          ) {
            this.state.settleFailure(pending, error, errorClassification(error));
            break;
          }

          pending.attempts.push(
            this.state.evidence.failureAttempt(pending, error, errorClassification(error)),
          );
          beginRetry(pending);
          this.state.evidence.record(pending, { classification: 'retry_scheduled' });

          const retrySignal = AbortSignal.any([
            this.state.lifecycle.signal,
            ...(signal === undefined ? [] : [signal]),
          ]);

          yield* Effect.raceFirst(
            waitForWebSocketRetry(
              retryBackoffDelay(this.state.agent.retry?.backoff, retry),
              retrySignal,
            ),
            Deferred.await(terminal),
          );

          if (!this.state.pending.has(pending.requestId)) break;

          if (retrySignal.aborted) {
            this.state.settleFailure(
              pending,
              new AgentInvocationError('cancelled', 'WebSocket retry was cancelled.'),
              'cancelled',
            );
            break;
          }

          this.state.arm(pending);
        }

        const result = yield* Deferred.await(terminal);

        return retainWebSocketOpeningResult(result, openingCause);
      });

      return yield* work.pipe(Effect.ensuring(Effect.sync(() => this.state.abandon(pending))));
    });
  }

  /** Serializes connection acquisition so concurrent cases cannot create competing generations. */
  private ensureConnection(): Effect.Effect<WebSocketConnection, AgentInvocationError> {
    return this.opening.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.connection !== undefined) return this.connection;

        if (this.state.lifecycle.signal.aborted)
          return yield* Effect.fail(
            new AgentInvocationError('cancelled', 'WebSocket session is closed.'),
          );
        const generation = ++this.generation;

        const lost = (error: AgentInvocationError): void => {
          if (generation !== this.generation) return;
          clearInterval(this.ping);
          this.connection?.destroy();
          this.connection = undefined;

          for (const pending of [...this.state.pending.values()])
            this.state.settleFailure(pending, error, errorClassification(error));
        };

        const connection = yield* this.state.openConnection(this.state.lifecycle.signal, {
          onClose: (close) => {
            if (generation !== this.generation) return;

            for (const pending of this.state.pending.values())
              this.state.evidence.recordClose(pending, close);
            lost(
              new AgentInvocationError(
                'network',
                'WebSocket disconnected before requests settled.',
                { classification: 'unexpected_close' },
              ),
            );
          },
          onFailure: (error) => this.state.failRun(error, errorClassification(error)),
          onPong: () => {
            for (const pending of this.state.pending.values())
              this.state.evidence.record(pending, { classification: 'pong_received' });
          },
          onText: (text, bytes) => this.state.consumeMessage(text, bytes),
        });

        this.connection = connection;

        if (this.state.lifecycle.signal.aborted) {
          connection.destroy();

          return yield* Effect.fail(
            new AgentInvocationError('cancelled', 'WebSocket session is closed.'),
          );
        }

        for (const pending of this.state.pending.values())
          this.state.evidence.record(pending, { classification: 'connection_opened' });
        this.ping = setInterval(() => {
          if (!connection.ping()) return;

          for (const pending of this.state.pending.values())
            this.state.evidence.record(pending, { classification: 'ping_sent' });
        }, this.state.agent.transport.ping_interval_ms);

        return connection;
      }),
    );
  }
}

export { RunScopedWebSocketSession };
