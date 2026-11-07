import { Effect, Exit, Scope } from 'effect';
import { afterEach } from 'vitest';
import { createAgentRunner, type AgentRunnerOptions } from '../../index.js';
import { serveAgentRunner } from '../../node.js';

const owners: Scope.Closeable[] = [];

afterEach(async () => {
  for (const owner of owners.splice(0).reverse())
    await Effect.runPromise(Scope.close(owner, Exit.void));
});

/** Retains explicit test scopes until teardown, including accepted background work. */
const acquire = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const owner = await Effect.runPromise(Scope.make());
  owners.push(owner);

  return Effect.runPromise(Effect.provideService(effect, Scope.Scope, owner));
};

/** Executes each request as a separate foreign root while retaining the runner owner. */
const createRunner = async (options: AgentRunnerOptions) => {
  const runner = await acquire(createAgentRunner(options));

  return {
    native: runner,
    fetch: (request: Request) => Effect.runPromise(runner.fetch(request)),
    pending: runner.pending,
    drain: () => Effect.runPromise(runner.drain()),
    close: () => Effect.runPromise(runner.close()),
  };
};

const serveRunner = async (
  runner: Awaited<ReturnType<typeof createRunner>>,
  options: { port: number },
) => {
  const served = await acquire(serveAgentRunner(runner.native, options));

  return { url: served.url, close: () => Effect.runPromise(served.close()) };
};

export { acquire, createRunner, serveRunner };
