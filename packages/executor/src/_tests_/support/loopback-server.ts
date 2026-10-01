import { createServer, type RequestListener, type Server } from 'node:http';

type LoopbackServer = {
  close: () => Promise<void>;
  server: Server;
  /** Origin such as `http://127.0.0.1:1234`, without a trailing slash. */
  url: string;
};

/** Starts an HTTP server on an ephemeral loopback port for one test. */
const startLoopbackServer = async (handler: RequestListener): Promise<LoopbackServer> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Loopback test server did not bind a TCP port.');
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    server,
    url: `http://127.0.0.1:${String(address.port)}`,
  };
};

export { startLoopbackServer, type LoopbackServer };
