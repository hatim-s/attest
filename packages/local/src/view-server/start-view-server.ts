import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { serve, type ServerType } from '@hono/node-server';

import { openStore } from '../store/index.js';
import { createViewApp } from './create-view-app.js';
import type { StartViewServerOptions, ViewServerHandle } from './types.js';

const closeServer = (server: ServerType): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

/** Opens the store and a loopback-only ephemeral server as one closeable lifecycle. */
const startViewServer = async (options: StartViewServerOptions): Promise<ViewServerHandle> => {
  await mkdir(dirname(options.storePath), { recursive: true });
  const store = await openStore(options.storePath);
  const sessionToken = options.sessionToken ?? randomBytes(32).toString('base64url');
  let origin: string | undefined;
  let server: ServerType | undefined;
  let closePromise: Promise<void> | undefined;
  let storeClosePromise: Promise<void> | undefined;
  const closeStore = (): Promise<void> => {
    storeClosePromise ??= store.close();
    return storeClosePromise;
  };
  const closeHandle = (): Promise<void> => {
    if (server === undefined) return Promise.resolve();
    closePromise ??= closeServer(server).then(closeStore);
    return closePromise;
  };
  const app = createViewApp({
    allowedOrigin: () => origin,
    indexHtml: options.indexHtml,
    sessionToken,
    store,
    onShutdown: () => {
      // Let Hono flush the 204 response before closing the listening socket.
      setImmediate(() => void closeHandle());
    },
  });

  try {
    server = await new Promise<ServerType>((resolve, reject) => {
      const candidate = serve(
        {
          fetch: app.fetch,
          hostname: '127.0.0.1',
          port: options.port ?? 0,
        },
        ({ port }) => {
          origin = `http://127.0.0.1:${String(port)}`;
          resolve(candidate);
        },
      );
      candidate.once('error', reject);
    });
  } catch (error: unknown) {
    await store.close();
    throw error;
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.once('close', () => {
      void closeStore().then(resolve, reject);
    });
    server.once('error', reject);
  });

  const resolvedOrigin = origin;
  if (resolvedOrigin === undefined) {
    await closeHandle();
    throw new Error('View server started without a resolved loopback origin.');
  }
  return {
    close: closeHandle,
    closed,
    origin: resolvedOrigin,
    sessionToken,
    url: `${resolvedOrigin}/#token=${encodeURIComponent(sessionToken)}`,
  };
};

export { startViewServer };
