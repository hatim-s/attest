import { resolve } from 'node:path';

import { dashboardHtml } from '@attest/web/embedded';

import { startViewServer, type ViewServerHandle } from '../view-server/index.js';

type RunViewCommandOptions = {
  onReady?: (server: ViewServerHandle) => void | Promise<void>;
  port?: number;
  signal?: AbortSignal;
  storePath?: string;
  workingDirectory: string;
};

/** Starts the loopback dashboard and owns abort-driven shutdown. */
const runViewCommand = async (options: RunViewCommandOptions): Promise<ViewServerHandle> => {
  const server = await startViewServer({
    indexHtml: dashboardHtml,
    port: options.port,
    storePath: resolve(options.workingDirectory, options.storePath ?? '.attest/runs.db'),
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

export { runViewCommand, type RunViewCommandOptions };
