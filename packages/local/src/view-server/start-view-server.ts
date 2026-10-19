import { serve, type ServerType } from '@hono/node-server';

import { createViewApp } from './create-view-app.js';
import type { StartViewServerOptions, ViewServerHandle } from './types.js';

const closeServer = (server: ServerType): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

/** Serves the catalog on a loopback-only ephemeral port as one closeable lifecycle. */
const startViewServer = async (options: StartViewServerOptions): Promise<ViewServerHandle> => {
  let origin: string | undefined;
  let server: ServerType | undefined;
  let closePromise: Promise<void> | undefined;
  let catalogClosePromise: Promise<void> | undefined;

  const closeCatalog = (): Promise<void> => {
    catalogClosePromise ??= options.close();

    return catalogClosePromise;
  };

  const closeHandle = (): Promise<void> => {
    if (server === undefined) return Promise.resolve();
    closePromise ??= closeServer(server).then(closeCatalog);

    return closePromise;
  };

  try {
    const app = createViewApp({
      allowedOrigin: () => origin,
      indexHtml: options.indexHtml,
      catalog: options.catalog,
    });

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
    await closeCatalog();
    throw error;
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.once('close', () => {
      void closeCatalog().then(resolve, reject);
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
    url: `${resolvedOrigin}/`,
  };
};

export { startViewServer };
