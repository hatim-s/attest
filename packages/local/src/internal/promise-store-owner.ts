import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { withStoreScope, type StoreScope } from '../store/index.js';
import { valueFromExit } from './effect-exit.js';

/** Holds native storage until a later-slice Promise parent supplies its actual terminal Exit. */
const startPromiseStoreOwner = async <A, E extends Error>(
  acquire: (owner: StoreScope) => Effect.Effect<A, E>,
) => {
  let complete: (exit: Exit.Exit<void, Error>) => void = () => {};

  const terminal = new Promise<Exit.Exit<void, Error>>((resolve) => {
    complete = resolve;
  });

  let publish: (value: A) => void = () => {};

  let reject: (error: Error) => void = () => {};

  const ready = new Promise<A>((resolve, fail) => {
    publish = resolve;
    reject = fail;
  });

  // EFFECT-BRIDGE(S8b)
  const finished = Effect.runPromiseExit(
    withStoreScope((owner) =>
      Effect.gen(function* () {
        const value = yield* acquire(owner);
        publish(value);

        return yield* yield* Effect.promise(() => terminal);
      }),
    ),
  );

  // Observe acquisition failures immediately, and retain terminal cleanup failures for finish.
  void finished.then((exit) => {
    if (Exit.isFailure(exit)) {
      try {
        valueFromExit(exit);
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error('Native owner failed.', { cause: error }),
        );
      }
    }
  });

  return {
    value: await ready,
    finish: async (exit: Exit.Exit<void, Error> = Exit.void) => {
      complete(exit);

      return valueFromExit(await finished);
    },
  };
};

export { startPromiseStoreOwner };
