import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import { StoreError } from '@attest/core';
import { PROJECT_STORE_PATH } from '../../project/project-store-path.js';
import { LocalError } from '../../errors/index.js';
import * as Semaphore from 'effect/Semaphore';
import { withStoreScope, type StoreScope } from '../../store/index.js';
import { CancellationRegistry } from './eval-cancellation.js';
import { openEvalProjectStore } from './eval-project-path.js';

type Application = {
  scope: Scope.Scope;
  owner: StoreScope;
  stores: Map<string, Effect.Success<ReturnType<typeof openEvalProjectStore>>>;
  opens: Semaphore.Semaphore;
  runs: { fiber: Fiber.Fiber<unknown, Error>; controller: AbortController }[];
};

/** Retains joined run Exits on an interrupted or failed application Cause, outside wire data. */
class EvalApplicationCompletion extends Context.Service<
  EvalApplicationCompletion,
  readonly Exit.Exit<unknown, Error>[]
>()('attest/EvalApplicationCompletion') {}

/** Captures the application scope rather than a request or Commander action scope. */
class EvalApplication extends Context.Service<EvalApplication, Application>()(
  'attest/EvalApplication',
) {}

/** Joins every admitted run before the store owner closes its shared handles. */
const withEvalApplication = <A, E, R>(
  use: Effect.Effect<A, E, R | EvalApplication | CancellationRegistry>,
) =>
  withStoreScope((owner) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.scoped(
        Effect.gen(function* () {
          const application: Application = {
            scope: yield* Effect.scope,
            owner,
            stores: new Map(),
            opens: Semaphore.makeUnsafe(1),
            runs: [],
          };

          const primary = yield* Effect.exit(
            restore(
              use.pipe(
                Effect.provideService(EvalApplication, application),
                Effect.provideService(CancellationRegistry, new Map()),
              ),
            ),
          );

          // Business cancellation lets the masked evidence owners finalize before the join.
          if (Exit.isFailure(primary)) for (const run of application.runs) run.controller.abort();
          const exits: Exit.Exit<unknown, Error>[] = [];

          for (const run of application.runs) exits.push(yield* Fiber.await(run.fiber));

          const completed = Exit.isFailure(primary)
            ? Exit.failCause(
                Cause.annotate(primary.cause, Context.make(EvalApplicationCompletion, exits), {
                  overwrite: true,
                }),
              )
            : primary;

          // Each run reports its outcome through admission or its event source. Joining it is not
          // application cleanup; rethrowing here would duplicate a failure the caller already handled.
          return yield* completed;
        }),
      ),
    ),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof StoreError
        ? new LocalError('run_failed', 'The eval store boundary changed during opening.', {
            path: PROJECT_STORE_PATH,
            cause: error,
          })
        : error,
    ),
  );

/** Serializes path capture and shares one runs/cache handle per project in this application. */
const applicationStore = Effect.fn('applicationStore')(function* (projectRoot: string) {
  const app = yield* EvalApplication;

  return yield* app.opens.withPermit(
    Effect.gen(function* () {
      const existing = app.stores.get(projectRoot);

      if (existing !== undefined) return existing;
      const store = yield* openEvalProjectStore(projectRoot, app.owner);
      app.stores.set(projectRoot, store);

      return store;
    }),
  );
});

export { EvalApplicationCompletion, EvalApplication, withEvalApplication, applicationStore };
