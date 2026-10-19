import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createSingleProjectCatalog, type RunControl } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { describeStoreProject } from '../project/describe-store-project.js';
import { createRegistryCatalog, readRegistry, type ClosableCatalog } from '../registry/index.js';
import { createRunLauncher, type CliCommand } from '../run-control/index.js';
import { openStore } from '../store/index.js';
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
type ViewCatalog = { catalog: ClosableCatalog; control: RunControl | undefined };

/**
 * Opens the catalog for one view scope. A store scope creates the store when it is missing, as
 * `attest view` always has. A registry scope creates nothing and opens stores on first read; it
 * reads the registry once here so an unreadable file fails in the terminal before the server
 * starts, not later as a generic API error in the browser.
 */
const openViewCatalog = async (
  scope: ViewScope,
  workingDirectory: string,
  command: CliCommand,
): Promise<ViewCatalog> => {
  if (scope.kind === 'registry') {
    await readRegistry(scope.registryPath);
    const catalog = createRegistryCatalog({ registryPath: scope.registryPath });

    // Registered stores are always `<root>/.attest/runs.db`, where the CLI records runs.
    return { catalog, control: createRunLauncher({ catalog, command }) };
  }

  const storePath = resolve(workingDirectory, scope.storePath ?? '.attest/runs.db');
  const project = await describeStoreProject(storePath);
  await mkdir(dirname(storePath), { recursive: true });
  const store = await openStore(storePath);

  const catalog = {
    ...createSingleProjectCatalog(project, store.runs),
    close: () => store.close(),
  };

  // The CLI records a run in `<root>/.attest/runs.db`; from any other store, a started run
  // would land where this dashboard does not look, so the dashboard only reads.
  const ownStore =
    project.root !== undefined && storePath === join(project.root, '.attest', 'runs.db');

  return { catalog, control: ownStore ? createRunLauncher({ catalog, command }) : undefined };
};

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
  const { catalog, control } = await openViewCatalog(
    options.scope,
    options.workingDirectory,
    await resolveCliCommand(),
  );

  const server = await startViewServer({
    indexHtml: dashboardHtml,
    port: options.port,
    catalog,
    control,
    close: catalog.close,
  });

  const closeOnAbort = (): void => {
    void server.close();
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
    await server.close();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', closeOnAbort);
  }
};

export { runViewCommand, type RunViewCommandOptions, type ViewScope };
