import type { AgentRequest } from '@attest/contracts';
import {
  AgentInvocationError,
  createLoopbackCompletionReceiver,
  invokeCallbackAgent,
  type InvocationResult,
} from '@attest/executor';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import type { ResolvedNativeAgent } from './types.js';

/** Keeps the receiver in the run scope until every admitted callback invocation has settled. */
const startCallbackSession = Effect.fn('startCallbackSession')(function* (
  resolved: Extract<ResolvedNativeAgent, { kind: 'callback' }>,
) {
  const scope = yield* Effect.scope;

  const receiver = yield* createLoopbackCompletionReceiver({
    listenPort: resolved.agent.transport.receiver?.listen_port,
    publicUrl: resolved.agent.transport.receiver?.public_url,
    bodyCapBytes: resolved.agent.limits?.response_bytes ?? 10 * 1024 * 1024,
  });

  const active = new Set<Fiber.Fiber<InvocationResult, AgentInvocationError>>();
  let closed = false;

  /** Masks admission through installation; waiter interruption cannot cancel its siblings. */
  const invoke = (request: AgentRequest, signal?: AbortSignal) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed)
          return yield* Effect.fail(
            new AgentInvocationError('cancelled', 'Callback session is closed.'),
          );

        const fiber = yield* Effect.forkIn(
          invokeCallbackAgent(resolved.agent, request, {
            receiver,
            trigger: resolved.trigger,
            artifactFetch: resolved.artifactFetch,
            traceFetch: resolved.traceFetch,
            secrets: resolved.secrets,
            signal,
          }),
          scope,
        );

        active.add(fiber);
        const result = yield* Effect.exit(restore(Fiber.join(fiber)));
        // Joining an interrupted waiter still drains its accepted invocation before returning.
        yield* Fiber.await(fiber);
        active.delete(fiber);

        return yield* result;
      }),
    );

  const close = Effect.uninterruptible(
    Effect.gen(function* () {
      closed = true;
      yield* Effect.forEach([...active], Fiber.await, { concurrency: 'unbounded' });
      yield* receiver.close();
    }),
  );

  yield* Scope.addFinalizer(scope, Effect.asVoid(Effect.exit(close)));

  return { invoke, close: () => close };
});

export { startCallbackSession };
