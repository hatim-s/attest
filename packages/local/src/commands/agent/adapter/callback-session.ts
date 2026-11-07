import type { AgentRequest } from '@attest/contracts';
import {
  AgentInvocationError,
  createLoopbackCompletionReceiver,
  invokeCallbackAgent,
  type InvocationResult,
} from '@attest/executor';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import { valueFromExit } from '../../../internal/effect-exit.js';
import type { ResolvedNativeAgent } from './types.js';

/** Attaches scope disposal evidence without replacing a failed callback operation. */
class CallbackScopeCleanup extends Context.Service<CallbackScopeCleanup, Exit.Exit<void, never>>()(
  'attest/local/callback-scope-cleanup',
) {}

/** Closes the retained scope with its actual outcome and preserves primary Cause precedence. */
const finishScope = <A, E>(scope: Scope.Closeable, outcome: Exit.Exit<A, E>) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const cleanup = yield* Effect.exit(Scope.close(scope, outcome));

      if (Exit.isFailure(outcome))
        return yield* Effect.failCause(
          Exit.isFailure(cleanup)
            ? Cause.annotate(outcome.cause, Context.make(CallbackScopeCleanup, cleanup))
            : outcome.cause,
        );

      if (Exit.isFailure(cleanup)) return yield* Effect.failCause(cleanup.cause);

      return outcome.value;
    }),
  );

/** Keeps the native receiver alive across Promise-owned local invocations until S7b. */
const startCallbackSession = async (
  resolved: Extract<ResolvedNativeAgent, { kind: 'callback' }>,
) => {
  // EFFECT-BRIDGE(S7b)
  const opened = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const scope = yield* Scope.make();

      const receiver = yield* Effect.exit(
        Effect.provideService(
          createLoopbackCompletionReceiver({
            listenPort: resolved.agent.transport.receiver?.listen_port,
            publicUrl: resolved.agent.transport.receiver?.public_url,
            bodyCapBytes: resolved.agent.limits?.response_bytes ?? 10 * 1024 * 1024,
          }),
          Scope.Scope,
          scope,
        ),
      );

      if (Exit.isFailure(receiver))
        return yield* finishScope(scope, Exit.failCause(receiver.cause));

      return { scope, receiver: receiver.value };
    }),
  );

  const { scope, receiver } = valueFromExit(opened);
  const active = new Set<Promise<Exit.Exit<InvocationResult, AgentInvocationError>>>();
  let closing: Promise<void> | undefined;

  /** Admission is synchronous; close can therefore join the complete accepted set. */
  const invoke = async (request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> => {
    if (closing !== undefined)
      throw new AgentInvocationError('cancelled', 'Callback session is closed.');

    // EFFECT-BRIDGE(S7b)
    const pending = Effect.runPromiseExit(
      invokeCallbackAgent(resolved.agent, request, {
        receiver,
        trigger: resolved.trigger,
        artifactFetch: resolved.artifactFetch,
        traceFetch: resolved.traceFetch,
        secrets: resolved.secrets,
        signal,
      }),
    );

    active.add(pending);

    try {
      return valueFromExit(await pending);
    } finally {
      active.delete(pending);
    }
  };

  /** Stops admission, joins accepted attempts and always disposes the receiver scope. */
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await Promise.all(active);

      // EFFECT-BRIDGE(S7b)
      const closed = await Effect.runPromiseExit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const outcome = yield* Effect.exit(receiver.close());

            return yield* finishScope(scope, outcome);
          }),
        ),
      );

      valueFromExit(closed);
    })();

    return closing;
  };

  return { invoke, close };
};

export { startCallbackSession };
