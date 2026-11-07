import * as Effect from 'effect/Effect';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createSingleProjectCatalog, type RunControl, type ProjectCatalog } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { describeStoreProject } from '../project/describe-store-project.js';
import { createRegistryCatalog, readRegistry } from '../registry/index.js';
import { createRunLauncher, type CliCommand } from '../run-control/index.js';
import { openStore, type StoreScope } from '../store/index.js';
import { startPromiseStoreOwner } from '../internal/promise-store-owner.js';
import * as Exit from 'effect/Exit';
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
 * `attest view` always has. A registry scope creates nothing and opens stores on first read; it
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

    return { catalog, control: createRunLauncher({ catalog, command }) };
  }

  const storePath = resolve(workingDirectory, scope.storePath ?? '.attest/runs.db');
  const project = yield* describeStoreProject(storePath);
  yield* Effect.tryPromise({
    try: () => mkdir(dirname(storePath), { recursive: true }),
    catch: (cause) => new Error('Could not create view store directory.', { cause }),
  });
  const store = yield* openStore(storePath, owner);
  const catalog = createSingleProjectCatalog(project, store.runs);

  const ownStore =
    project.root !== undefined && storePath === join(project.root, '.attest', 'runs.db');

  return {
    catalog,
    control: ownStore ? createRunLauncher({ catalog, command }) : undefined,
  } satisfies ViewCatalog;
});

/**
 * The CLI serving the dashboard, so runs it starts use the same version and runtime. `argv[1]`
 * is the script the runtime executes; through the `attest` bin link it is that link, which
 * `stat` follows. The runtime's own flags, such as `--import`, come first so the child loads what
 * the server loaded. A program that embeds `runCli` is `argv[1]` itself, so that program is what
 * runs. Only when `argv[1]` is not a file (a compiled binary) is `attest` taken from PATH.
 */
const resolveCliCommand = async (): Promise<CliCommand> => {
  const script = process.argv[1];

  const isFile =
    script !== undefined &&
    (await stat(script).then(
      (entry) => entry.isFile(),
      () => false,
    ));

  return isFile
    ? { command: process.execPath, args: [...process.execArgv, script] }
    : { command: 'attest', args: [] };
};

/** Starts the loopback dashboard and owns abort-driven shutdown. */
const runViewCommand = async (options: RunViewCommandOptions): Promise<ViewServerHandle> => {
  const command = await resolveCliCommand();

  const lifetime = await startPromiseStoreOwner((owner) =>
    openViewCatalog(options.scope, options.workingDirectory, command, owner),
  );

  const { catalog, control } = lifetime.value;
  let server: ViewServerHandle;
  let terminal: Exit.Exit<void, Error> = Exit.void;

  try {
    server = await startViewServer({
      indexHtml: dashboardHtml,
      port: options.port,
      catalog,
      control,
      close: () => lifetime.finish(terminal),
    });
  } catch (error: unknown) {
    // startViewServer already attached any release failure to the startup error.
    await lifetime
      .finish(error instanceof Error ? Exit.fail(error) : Exit.die(error))
      .catch(() => undefined);
    throw error;
  }

  // Observe rejection while onReady is pending; the command still awaits the same closed promise.
  void server.closed.catch(() => {});

  const closeOnAbort = (): void => {
    // closed carries shutdown failures to the awaiting command.
    void server.close().catch(() => {});
  };

  options.signal?.addEventListener('abort', closeOnAbort, { once: true });

  try {
    await options.onReady?.(server);

    if (options.signal?.aborted === true) {
      await server.close();
    }

    await server.closed;

    return server;
  } catch (error: unknown) {
    terminal = error instanceof Error ? Exit.fail(error) : Exit.die(error);

    try {
      await server.close();
    } catch (cleanup) {
      if (cleanup !== error) {
        const primary =
          error instanceof Error ? error : new Error('View command failed.', { cause: error });

        Object.defineProperty(primary, 'cleanupFailure', { value: cleanup, configurable: true });
        throw primary;
      }
    }

    throw error;
  } finally {
    options.signal?.removeEventListener('abort', closeOnAbort);
  }
};

export { runViewCommand, type RunViewCommandOptions, type ViewScope };
