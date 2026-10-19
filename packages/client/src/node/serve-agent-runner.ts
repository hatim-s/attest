import { isString } from '@attest/contracts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { AgentRunner } from '../runner/agent-runner.js';

type ServeAgentRunnerOptions = {
  /** Defaults to loopback. Binding wider exposes the handler; set the runner's `triggerToken`. */
  host?: string;
  /** `0` picks a free port; read it back from `url`. */
  port: number;
};

type ServedAgentRunner = {
  /** Origin such as `http://127.0.0.1:8790`, without a trailing slash. */
  url: string;
  /** Stops listening. Accepted invocations keep running; call `runner.drain()` to wait. */
  close: () => Promise<void>;
};

/** Streams a Node request body on demand, so the runner's byte cap stops reading early. */
const toWebBody = (incoming: IncomingMessage): ReadableStream<Uint8Array> => {
  // SAFETY: an IncomingMessage with no text encoding set yields Buffer chunks.
  const chunks = (incoming as AsyncIterable<Buffer>)[Symbol.asyncIterator]();

  return new ReadableStream({
    pull: async (controller) => {
      const next = await chunks.next();

      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: () => {
      incoming.destroy();
    },
  });
};

/** Bridges a Node request to a Web `Request`. */
const toWebRequest = (incoming: IncomingMessage, origin: string): Request => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, item);
    }
  }

  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // Node's Request needs `duplex: 'half'` for a streamed body; the DOM RequestInit type omits it.
  const init: RequestInit & { duplex: 'half' } = {
    method,
    headers,
    body: hasBody ? toWebBody(incoming) : null,
    duplex: 'half',
  };

  return new Request(new URL(incoming.url ?? '/', origin), init);
};

const writeWebResponse = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
};

/**
 * Serves a runner over `node:http`. Bun and Workers do not need this: pass `runner.fetch` to
 * `Bun.serve({ fetch })` or export it as a Worker's `fetch`.
 */
const serveAgentRunner = async (
  runner: AgentRunner,
  { host = '127.0.0.1', port }: ServeAgentRunnerOptions,
): Promise<ServedAgentRunner> => {
  let origin = '';

  const respond = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    try {
      await writeWebResponse(await runner.fetch(toWebRequest(incoming, origin)), outgoing);
    } catch (error) {
      console.error('[attest-client] request failed:', error);

      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  };

  const server = createServer((incoming, outgoing) => void respond(incoming, outgoing));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();

  if (address === null || isString(address)) {
    throw new Error('The runner server did not bind a TCP port.');
  }

  origin = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${String(address.port)}`;

  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

export { serveAgentRunner, type ServeAgentRunnerOptions, type ServedAgentRunner };
