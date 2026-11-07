import * as Effect from 'effect/Effect';
import type { StoreError } from '@attest/core';
import { valueFromExit } from '../../internal/effect-exit.js';
import { openStore, openReadonlyRunStore } from '../run-store.js';
import { withStoreScope, type StoreScope } from '../internal/store-scope.js';

/** Executes a native operation at a test's foreign assertion boundary. */
const run = async <A, E extends Error>(operation: Effect.Effect<A, E>): Promise<A> =>
  valueFromExit(await Effect.runPromiseExit(operation));

/** Keeps each fixture inside its real lifetime owner until test teardown acknowledges release. */
const startFixture = async <A>(acquire: (owner: StoreScope) => Effect.Effect<A, StoreError>) => {
  let release = () => {};

  const done = new Promise<void>((resolve) => {
    release = resolve;
  });

  let publish: (store: A) => void = () => {};

  let reject: (error: Error) => void = () => {};

  const ready = new Promise<A>((resolve, fail) => {
    publish = resolve;
    reject = fail;
  });

  const finished = run(
    withStoreScope((owner) =>
      Effect.gen(function* () {
        const store = yield* acquire(owner);
        publish(store);
        yield* Effect.promise(() => done);
      }),
    ),
  );

  void finished.catch(reject);
  const store = await ready;

  return {
    store,
    close: async () => {
      release();
      await finished;
    },
  };
};

const openFixture = (path: string) => startFixture((owner) => openStore(path, owner));

const openReadonlyFixture = (path: string) =>
  startFixture((owner) => openReadonlyRunStore(path, owner));

export { run, openFixture, openReadonlyFixture, startFixture };
