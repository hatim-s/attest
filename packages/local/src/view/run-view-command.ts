import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createSingleProjectCatalog, type ProjectCatalog } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { createRegistryCatalog, describeStoreProject } from '../registry/index.js';
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

type OpenedCatalog = { catalog: ProjectCatalog; close: () => Promise<void> };

/**
 * Opens the catalog for one view scope. A store scope creates the store when it is missing, as
 * `attest view` always has; a registry scope creates nothing and opens stores on first read.
 */
const openViewCatalog = async (
  scope: ViewScope,
  workingDirectory: string,
): Promise<OpenedCatalog> => {
  if (scope.kind === 'registry') {
    const catalog = createRegistryCatalog({ registryPath: scope.registryPath });

    return { catalog, close: catalog.close };
  }

  const storePath = resolve(workingDirectory, scope.storePath ?? '.attest/runs.db');
  const project = await describeStoreProject(storePath);
  await mkdir(dirname(storePath), { recursive: true });
  const store = await openStore(storePath);

  return {
    catalog: createSingleProjectCatalog(project, store.runs),
    close: () => store.close(),
  };
};

/** Starts the loopback dashboard and owns abort-driven shutdown. */
const runViewCommand = async (options: RunViewCommandOptions): Promise<ViewServerHandle> => {
  const { catalog, close } = await openViewCatalog(options.scope, options.workingDirectory);

  const server = await startViewServer({
    indexHtml: dashboardHtml,
    port: options.port,
    catalog,
    close,
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
