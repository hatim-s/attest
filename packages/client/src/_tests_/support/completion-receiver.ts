import { isString } from '@attest/contracts';
import { createServer } from 'node:http';

type ReceivedCompletion = { authorization: string | undefined; body: string };

type CompletionReceiver = {
  /** Origin plus the attest completion path, ready to use as `callback.url`. */
  url: string;
  received: ReceivedCompletion[];
  close: () => Promise<void>;
};

/**
 * Stands in for attest's completion receiver. It answers with `statuses` in order, then 202, and
 * records every request so tests can assert retries and the bearer token.
 */
const startCompletionReceiver = async (statuses: number[] = []): Promise<CompletionReceiver> => {
  const received: ReceivedCompletion[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(statuses.shift() ?? 202, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address === null || isString(address) ? 0 : address.port;

  return {
    url: `http://127.0.0.1:${String(port)}/attest/completions/run/case`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export { startCompletionReceiver, type CompletionReceiver };
