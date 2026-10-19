import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createSingleProjectCatalog } from '@attest/core';
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

/**
 * Opens the catalog for one view scope. A store scope creates the store when it is missing, as
 * `attest view` always has. A registry scope creates nothing and opens stores on first read; it
 * reads the registry once here so an unreadable file fails in the terminal before the server
 * starts, not later as a generic API error in the browser.
 */
const openViewCatalog = async (
  scope: ViewScope,
  workingDirectory: string,
): Promise<ClosableCatalog> => {
  if (scope.kind === 'registry') {
    await readRegistry(scope.registryPath);

    return createRegistryCatalog({ registryPath: scope.registryPath });
  }

  const storePath = resolve(workingDirectory, scope.storePath ?? '.attest/runs.db');
  const project = await describeStoreProject(storePath);
  await mkdir(dirname(storePath), { recursive: true });
  const store = await openStore(storePath);

  return { ...createSingleProjectCatalog(project, store.runs), close: () => store.close() };
};

/**
 * The CLI serving the dashboard, so runs it starts use the same version and runtime. `argv[1]`
 * is the script the runtime executes; through the `attest` bin link it is that link, which
 * `stat` follows. Only when it is not a file (a compiled binary) is `attest` taken from PATH.
 */
const resolveCliCommand = async (): Promise<CliCommand> => {
  const script = process.argv[1];

  const isFile =
    script !== undefined &&
    (await stat(script).then(
      (entry) => entry.isFile(),
      () => false,
    ));

  return isFile ? { command: process.execPath, args: [script] } : { command: 'attest', args: [] };
};

/** Starts the loopback dashboard and owns abort-driven shutdown. */
const runViewCommand = async (options: RunViewCommandOptions): Promise<ViewServerHandle> => {
  const catalog = await openViewCatalog(options.scope, options.workingDirectory);

  const server = await startViewServer({
    indexHtml: dashboardHtml,
    port: options.port,
    catalog,
    control: createRunLauncher({ catalog, command: await resolveCliCommand() }),
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
