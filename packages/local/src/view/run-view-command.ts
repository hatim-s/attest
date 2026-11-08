import { AttestError, tryPromiseClassify } from '@attest/contracts';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createSingleProjectCatalog, type RunControl, type ProjectCatalog } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { describeStoreProject } from '../project/describe-store-project.js';
import { createRegistryCatalog, readRegistry } from '../registry/index.js';
import { createRunLauncher, type CliCommand } from '../run-control/index.js';
import { openStore, type StoreScope } from '../store/index.js';
import { withStoreScope } from '../store/index.js';
import { anchoredCall } from '../internal/open-anchored.js';
import { finishOperation } from '../internal/operation-cleanup.js';
import { CancellationRegistry } from '../commands/eval/eval-cancellation.js';
import { startViewServer, type ViewServerHandle } from '../view-server/index.js';

/** What the dashboard serves: one project's store, or every project in the registry. */
type ViewScope = { kind: 'store'; storePath?: string } | { kind: 'registry'; registryPath: string };

type RunViewCommandOptions = {
  onReady?: (server: ViewServerHandle) => void | Promise<void>;
  port?: number;
  scope: ViewScope;
  signal?: AbortSignal;
  workingDirectory: string;
};

/** The served catalog, and the run control for it when dashboard runs land in what it serves. */
type ViewCatalog = { catalog: ProjectCatalog; control: RunControl | undefined };

/**
 * Opens the catalog for one view scope. A store scope creates the store when it is missing, as
 * the dashboard always has. A registry scope creates nothing and opens stores on first read; it
 * reads the registry once here so an unreadable file fails in the terminal before the server
 * starts, not later as a generic API error in the browser.
 */
const openViewCatalog = Effect.fn('openViewCatalog')(function* (
  scope: ViewScope,
  workingDirectory: string,
  command: CliCommand,
  owner: StoreScope,
) {
  if (scope.kind === 'registry') {
    yield* readRegistry(scope.registryPath);
    const catalog = createRegistryCatalog({ registryPath: scope.registryPath }, owner);

    return { catalog, control: yield* createRunLauncher({ catalog, command }) };
  }

  const storePath = resolve(workingDirectory, scope.storePath ?? '.attest/runs.db');
  const project = yield* describeStoreProject(storePath);
  yield* anchoredCall('mkdir', dirname(storePath), () =>
    mkdir(dirname(storePath), { recursive: true }),
  );
  const store = yield* openStore(storePath, owner);
  const catalog = createSingleProjectCatalog(project, store.runs);

  const ownStore =
    project.root !== undefined && storePath === join(project.root, '.attest', 'runs.db');

  return {
    catalog,
    control: ownStore ? yield* createRunLauncher({ catalog, command }) : undefined,
  } satisfies ViewCatalog;
});

/**
 * The CLI serving the dashboard, so runs it starts use the same version and runtime. `argv[1]`
 * is the script the runtime executes; through the `attest` bin link it is that link, which
 * `stat` follows. The runtime's own flags, such as `--import`, come first so the child loads what
 * the server loaded. A program that embeds `runCli` is `argv[1]` itself, so that program is what
 * runs. Only when `argv[1]` is not a file (a compiled binary) is `attest` taken from PATH.
 */
const resolveCliCommand = Effect.fn('resolveCliCommand')(function* () {
  const script = process.argv[1];

  const isFile =
    script !== undefined &&
    (yield* Effect.tryPromise({ try: () => stat(script), catch: () => false as const }).pipe(
      Effect.map((entry) => entry.isFile()),
      Effect.catch(() => Effect.succeed(false)),
    ));

  return isFile
    ? { command: process.execPath, args: [...process.execArgv, script] }
    : { command: 'attest', args: [] };
});

/** Starts the loopback dashboard and owns abort-driven shutdown. */
const runViewCommand = Effect.fn('runViewCommand')(function* (options: RunViewCommandOptions) {
  const command = yield* resolveCliCommand();

  return yield* withStoreScope((owner) =>
    Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { catalog, control } = yield* openViewCatalog(
            options.scope,
            options.workingDirectory,
            command,
            owner,
          );

          const server = yield* startViewServer({
            indexHtml: dashboardHtml,
            port: options.port,
            catalog,
            control,
            close: () => Effect.void,
          });

          const primary = yield* Effect.exit(
            restore(
              Effect.gen(function* () {
                if (options.onReady !== undefined)
                  yield* Effect.raceFirst(
                    // An embedder's AttestError (local or cli) keeps its code; any other failure stays unknown.
                    // The UnknownError message matches the one Effect.tryPromise gives it.
                    tryPromiseClassify(
                      async () => options.onReady?.(server),
                      (cause) =>
                        cause instanceof AttestError
                          ? cause
                          : new Cause.UnknownError(cause, 'An error occurred in Effect.tryPromise'),
                    ),
                    options.signal === undefined
                      ? Effect.never
                      : Effect.callback<void>((resume) => {
                          const abort = () => resume(Effect.void);
                          options.signal?.addEventListener('abort', abort, { once: true });

                          if (options.signal?.aborted) abort();

                          return Effect.sync(() =>
                            options.signal?.removeEventListener('abort', abort),
                          );
                        }).pipe(Effect.andThen(server.close()), Effect.andThen(Effect.never)),
                  );

                if (options.signal?.aborted) return;

                if (options.signal === undefined) return yield* server.closed;
                yield* Effect.raceFirst(
                  server.closed,
                  Effect.callback<void>((resume) => {
                    const abort = () => resume(Effect.void);
                    options.signal?.addEventListener('abort', abort, { once: true });

                    if (options.signal?.aborted) abort();

                    return Effect.sync(() => options.signal?.removeEventListener('abort', abort));
                  }),
                );
              }),
            ),
          );

          const release = yield* Effect.exit(server.close());
          yield* finishOperation(primary, [release]);

          return server;
        }),
      ),
    ),
  ).pipe(Effect.provideService(CancellationRegistry, new Map()));
});

export { runViewCommand, type RunViewCommandOptions, type ViewScope };
