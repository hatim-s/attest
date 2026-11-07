import type { AgentRequest } from '@attest/contracts';
import type { InvocationResult } from '../../../../types.js';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import * as Cause from 'effect/Cause';

/** Unwraps typed fixture failures while retaining defect Causes. */
const valueFromExit = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

type ProcessSession = {
  invoke(request: AgentRequest, signal?: AbortSignal): Effect.Effect<InvocationResult, Error>;
  close(): Effect.Effect<void, Error>;
};

/** Fixture owner retains the native run scope until accepted invocations and process cleanup finish. */
const openProcessSession = async (acquire: Effect.Effect<ProcessSession, Error, Scope.Scope>) => {
  // Fixture execution root: Promise eval lifetime retains this scope until close below.
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
      // Fixture execution root: retain every accepted invocation until the Promise run owner closes.
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
        // Fixture execution root: dispose the retained scope with the actual close Exit.
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
