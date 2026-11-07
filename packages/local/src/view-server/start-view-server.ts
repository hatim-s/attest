import { serve, type ServerType } from '@hono/node-server';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import { errnoCode } from '../internal/errno-code.js';
import { finishOperation } from '../internal/operation-cleanup.js';
import { createViewApp } from './create-view-app.js';
import type { StartViewServerOptions, ViewServerHandle } from './types.js';

/** Serves one native lifetime and joins accepted Hono work before releasing the catalog. */
const startViewServer = Effect.fn('startViewServer')(function* (options: StartViewServerOptions) {
  const scope = yield* Effect.scope;
  const closed = Deferred.makeUnsafe<void, Error>();
  const stopped = Deferred.makeUnsafe<Exit.Exit<void, Error>>();
  const idle = Deferred.makeUnsafe<void>();
  const lock = Semaphore.makeUnsafe(1);
  let origin: string | undefined;
  let server: ServerType | undefined;
  let accepting = true;
  let pending = 0;
  let terminal: Exit.Exit<void, Error> | undefined;

  const startup = yield* Effect.exit(
    Effect.gen(function* () {
      const app = createViewApp({
        allowedOrigin: () => origin,
        indexHtml: options.indexHtml,
        catalog: options.catalog,
        control: options.control,
      });

      const listening = Deferred.makeUnsafe<void, Error>();

      const candidate = yield* Effect.try({
        try: () =>
          serve(
            {
              hostname: '127.0.0.1',
              port: options.port ?? 0,
              // Hono owns its Promise callback. Track disconnected starts through their admission result.
              fetch: async (request, env) => {
                if (!accepting) return new Response('Server closing', { status: 503 });
                pending++;

                try {
                  return await app.fetch(request, env);
                } finally {
                  pending--;

                  if (!accepting && pending === 0) Deferred.doneUnsafe(idle, Effect.void);
                }
              },
            },
            ({ port }) => {
              origin = `http://127.0.0.1:${String(port)}`;
              Deferred.doneUnsafe(listening, Effect.void);
            },
          ),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) => {
          // Bun throws bind errors synchronously; Node emits the same codes from the listener.
          const code = errnoCode(cause);

          return cause instanceof Error &&
            (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL')
            ? Effect.fail(cause)
            : Effect.die(cause);
        }),
      );

      server = candidate;
      candidate.on('error', (error: Error) => {
        Deferred.doneUnsafe(stopped, Effect.succeed(Exit.fail(error)));
        Deferred.doneUnsafe(listening, Effect.fail(error));
      });
      candidate.once('close', () => Deferred.doneUnsafe(stopped, Effect.succeed(Exit.void)));
      yield* Deferred.await(listening);
    }),
  );

  /** Closes admission once; every caller observes the same complete release Exit. */
  const close = (primary: Exit.Exit<void, Error> = Exit.void) =>
    lock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (terminal !== undefined) return yield* terminal;
          accepting = false;
          const listener = server;
          const releases: Exit.Exit<unknown, Error>[] = [];

          if (listener !== undefined && listener.listening)
            releases.push(
              yield* Effect.exit(
                Effect.callback<void, Error>((resume) => {
                  listener.close((error) =>
                    resume(error === undefined ? Effect.void : Effect.fail(error)),
                  );

                  if ('closeIdleConnections' in listener) listener.closeIdleConnections();
                }),
              ),
            );

          if (pending > 0) yield* Deferred.await(idle);
          releases.push(yield* Effect.exit(options.close(primary)));
          terminal = yield* Effect.exit(finishOperation(primary, releases));
          yield* Deferred.done(closed, terminal);

          return yield* terminal;
        }),
      ),
    );

  if (Exit.isFailure(startup)) {
    yield* close(startup);

    return yield* Effect.failCause(startup.cause);
  }

  const resolvedOrigin = origin;

  if (resolvedOrigin === undefined) {
    const error = new Error('View server started without a resolved loopback origin.');
    const failure = Exit.fail(error);
    yield* close(failure);

    return yield* Effect.fail(error);
  }

  yield* Effect.forkIn(
    Effect.gen(function* () {
      const exit = yield* Deferred.await(stopped);
      yield* Effect.exit(close(exit));
    }),
    scope,
  );
  yield* Scope.addFinalizer(scope, Effect.asVoid(Effect.exit(close())));

  return {
    close,
    closed: Deferred.await(closed),
    origin: resolvedOrigin,
    url: `${resolvedOrigin}/`,
  } satisfies ViewServerHandle;
}, Effect.uninterruptible);

export { startViewServer };
