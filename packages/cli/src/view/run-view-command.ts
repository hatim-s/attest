import { resolve } from 'node:path';

import { startViewServer, type ViewServerHandle } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { openBrowser } from './open-browser.js';

type RunViewCommandOptions = {
  launchBrowser?: boolean;
  onReady?: (server: ViewServerHandle) => void | Promise<void>;
  opener?: (url: string) => Promise<boolean>;
  port?: number;
  signal?: AbortSignal;
  storePath?: string;
  workingDirectory: string;
};

/** Starts the loopback dashboard, optionally opens it, and owns abort-driven shutdown. */
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
    if (options.launchBrowser !== false) {
      await (options.opener ?? openBrowser)(server.url);
    }
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
