import type { AgentRequest } from '@attest/contracts';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Semaphore from 'effect/Semaphore';

import { AgentInvocationError } from '../../errors.js';
import type { InvocationResult } from '../../types.js';
import { PerCaseWebSocketSession } from './per-case-session.js';
import { RunScopedWebSocketSession } from './run-scoped-session.js';
import { withWebSocketRelease } from './websocket-lifetime.js';
import type { WebSocketAgentResource } from './websocket-protocol.js';
import type { WebSocketSessionOptions } from './websocket-session-state.js';

/** A native session must remain inside its acquisition scope until accepted work joins. */
type WebSocketAgentSession = {
  invoke: (
    request: AgentRequest,
    signal?: AbortSignal,
  ) => Effect.Effect<InvocationResult, AgentInvocationError>;
  close: () => Effect.Effect<void, AgentInvocationError>;
  /** Scope fallback records release failures even when an owner omits explicit close. */
  releaseExit: () => Exit.Exit<void, AgentInvocationError> | undefined;
};

/** Acquires a session and registers release before admitting invocations. */
const startWebSocketAgent = Effect.fn('startWebSocketAgent')(function* (
  agent: WebSocketAgentResource,
  options: WebSocketSessionOptions = {},
) {
  if (agent.transport.url.includes('{{')) {
    return yield* Effect.fail(
      new AgentInvocationError(
        'invalid_envelope',
        'WebSocket runtime URLs must have a static authority and path.',
      ),
    );
  }

  const implementation = yield* Effect.try({
    try: () =>
      agent.transport.lifecycle === 'per_case'
        ? new PerCaseWebSocketSession(agent, options)
        : new RunScopedWebSocketSession(agent, options),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof AgentInvocationError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );

  const accepted = new Set<Deferred.Deferred<void>>();
  const closing = Semaphore.makeUnsafe(1);
  let closed = false;
  let releaseExit: Exit.Exit<void, AgentInvocationError> | undefined;

  const session: WebSocketAgentSession = {
    releaseExit: () => releaseExit,
    // Admission and its join finalizer must be installed before interruption can resume.
    invoke: (request, signal) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (closed)
            return Effect.fail(
              new AgentInvocationError('cancelled', 'WebSocket session is closed.'),
            );
          const joined = Deferred.makeUnsafe<void>();
          accepted.add(joined);

          return restore(implementation.invoke(request, signal)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                accepted.delete(joined);
                Deferred.doneUnsafe(joined, Effect.void);
              }),
            ),
          );
        }),
      ),
    close: () =>
      closing.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (releaseExit !== undefined) return yield* releaseExit;
            closed = true;
            // The implementation first cancels observation, then joins every admitted request.
            const released = yield* Effect.exit(implementation.close());
            yield* Effect.forEach([...accepted], (joined) => Deferred.await(joined), {
              discard: true,
            });
            releaseExit = released;

            return yield* released;
          }),
        ),
      ),
  };

  yield* Effect.addFinalizer(() => Effect.asVoid(Effect.exit(session.close())));

  return session;
});

/** Owns the complete session and chooses primary versus release outcomes using R1-R3. */
const withWebSocketAgent = <A, E, R>(
  agent: WebSocketAgentResource,
  options: WebSocketSessionOptions,
  use: (session: WebSocketAgentSession) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* startWebSocketAgent(agent, options);

      return yield* withWebSocketRelease(
        Effect.suspend(() => use(session)),
        Effect.suspend(() => session.close()),
      );
    }),
  );

export {
  startWebSocketAgent,
  withWebSocketAgent,
  type WebSocketAgentResource,
  type WebSocketAgentSession,
  type WebSocketSessionOptions,
};
