import { AgentInvocationError, startWebSocketAgent } from '@attest/executor';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';

import { valueFromExit } from '../../../internal/effect-exit.js';

/** S7b owns this forward boundary until the evaluation lifetime itself returns Effect. */
const startWebSocketSession = async (...args: Parameters<typeof startWebSocketAgent>) => {
  const acquired = valueFromExit(
    // EFFECT-BRIDGE(S7b): keep scope alive until admitted work joins.
    await Effect.runPromiseExit(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const opened = yield* Effect.exit(Scope.provide(startWebSocketAgent(...args), scope));

        if (Exit.isFailure(opened)) {
          yield* Scope.close(scope, opened);

          return yield* Effect.failCause(opened.cause);
        }

        return { scope, session: opened.value };
      }),
    ),
  );

  let closed = false;
  const admitted = new Set<Promise<Exit.Exit<unknown, AgentInvocationError>>>();

  return {
    invoke: async (...invocation: Parameters<typeof acquired.session.invoke>) => {
      if (closed) throw new AgentInvocationError('cancelled', 'WebSocket session is closed.');
      // EFFECT-BRIDGE(S7b): Promise caller awaits the complete native invocation Exit.
      const outcome = Effect.runPromiseExit(acquired.session.invoke(...invocation));
      admitted.add(outcome);

      try {
        return valueFromExit(await outcome);
      } finally {
        admitted.delete(outcome);
      }
    },
    close: async () => {
      closed = true;

      // EFFECT-BRIDGE(S7b): native close joins its accepted work.
      const released = await Effect.runPromiseExit(acquired.session.close());
      await Promise.all([...admitted]);
      // EFFECT-BRIDGE(S7b): the foreign parent disposes its retained scope after all calls join.
      const disposed = await Effect.runPromiseExit(Scope.close(acquired.scope, released));
      valueFromExit(released);
      valueFromExit(disposed);
    },
  };
};

export { startWebSocketSession };
