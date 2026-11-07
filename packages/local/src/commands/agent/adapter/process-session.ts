import type { AgentRequest } from '@attest/contracts';
import type { InvocationResult } from '@attest/executor';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import { valueFromExit } from '../../../internal/effect-exit.js';

type ProcessSession = {
  invoke(request: AgentRequest, signal?: AbortSignal): Effect.Effect<InvocationResult, Error>;
  close(): Effect.Effect<void, Error>;
};

/** S7b retains the native run scope until accepted invocations and process cleanup finish. */
const openProcessSession = async (acquire: Effect.Effect<ProcessSession, Error, Scope.Scope>) => {
  // EFFECT-BRIDGE(S7b): Promise eval lifetime retains this scope until close below.
  const opened = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* Effect.exit(Scope.provide(scope)(acquire));

      if (Exit.isFailure(session)) {
        yield* Scope.close(scope, session);

        return yield* Effect.failCause(session.cause);
      }

      return { scope, session: session.value };
    }),
  );

  const { scope, session } = valueFromExit(opened);
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<InvocationResult>>();

  return {
    invoke(request: AgentRequest, signal?: AbortSignal): Promise<InvocationResult> {
      if (closing !== undefined) return Promise.reject(new Error('Process session is closed.'));
      // EFFECT-BRIDGE(S7b): retain every accepted invocation until the Promise run owner closes.
      const pending = Effect.runPromiseExit(session.invoke(request, signal)).then(valueFromExit);
      active.add(pending);
      void pending.then(
        () => active.delete(pending),
        () => active.delete(pending),
      );

      return pending;
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = (async () => {
        // Native close requests business cancellation before joining observers.
        // EFFECT-BRIDGE(S7b): dispose the retained scope with the actual close Exit.
        const exit = await Effect.runPromiseExit(
          Effect.gen(function* () {
            const closed = yield* Effect.exit(session.close());
            yield* Scope.close(scope, closed);

            return yield* closed;
          }),
        );

        await Promise.allSettled([...active]);
        valueFromExit(exit);
      })();

      return closing;
    },
  };
};

export { openProcessSession };
