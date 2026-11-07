import * as Effect from 'effect/Effect';
import { openFixture, startFixture, run } from './store-fixture.js';
import { createRegistryCatalog } from '../../registry/registry-catalog.js';

/** Keeps test handles alive until explicit fixture teardown, while methods remain native. */
const openTestStore = async (path: string) => {
  const fixture = await openFixture(path);

  return {
    ...fixture.store,
    close: fixture.close,
    runs: { ...fixture.store.runs, close: fixture.close },
  };
};

/** Supplies a real catalog owner for Promise-based test setup and teardown. */
const openTestCatalog = async (options: { registryPath: string }) => {
  const fixture = await startFixture((owner) =>
    Effect.succeed(createRegistryCatalog(options, owner)),
  );

  return { ...fixture.store, close: fixture.close };
};

export { openTestStore, openTestCatalog, run };
