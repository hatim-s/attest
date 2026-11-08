import { Cause, Data, Effect, Exit, Scope } from 'effect';
import { isString } from '@attest/contracts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { AgentRunner } from '../runner/agent-runner.js';

type ServeAgentRunnerOptions = {
  /** Defaults to loopback. Binding wider exposes the handler; set the runner's `triggerToken`. */
  host?: string;
  /** `0` picks a free port; read it back from `url`. */
  port: number;
};

type RunnerServerOperation = 'listen' | 'bind' | 'close' | 'join';

const RUNNER_SERVER_MESSAGES = {
  listen: 'Runner listen failed.',
  bind: 'The runner server did not bind a TCP port.',
  close: 'Runner listener close failed.',
  join: 'Runner request roots failed to join.',
} as const satisfies Record<RunnerServerOperation, string>;

/**
 * Binding, closing or joining the runner's `node:http` listener failed. `bind` has no cause because
 * the listener started but reported no TCP address.
 */
class RunnerServerError extends Data.TaggedError('RunnerServerError')<{
  operation: RunnerServerOperation;
  cause?: unknown;
}> {
  override readonly message = RUNNER_SERVER_MESSAGES[this.operation];
}

/**
 * Why `close()` failed: the listener close or request-root join failed, or both together ran past
 * their 12 second bound.
 */
type ListenerCloseError = RunnerServerError | Cause.TimeoutError;

type ListenerCleanup = { exit?: Exit.Exit<void, ListenerCloseError> };

type ServedAgentRunner = {
  /** Origin such as `http://127.0.0.1:8790`, without a trailing slash. */
  url: string;
  /** Stops listening. Accepted invocations keep running; call `runner.drain()` to wait. */
  close: () => Effect.Effect<void, ListenerCloseError>;
  /** Retained listener and request-root release evidence. Never serialize Causes. */
  cleanup: ListenerCleanup;
};

/**
 * Streams a Node request body into a Web stream, pausing the socket while the stream is full so
 * the runner's byte cap stops reading early.
 */
const toWebBody = (incoming: IncomingMessage): ReadableStream<Uint8Array> => {
  let ended = false;

  return new ReadableStream({
    start: (controller) => {
      incoming.on('data', (chunk: Buffer) => {
        if (ended) return;
        controller.enqueue(chunk);

        if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
      });
      incoming.on('end', () => {
        if (!ended) {
          ended = true;
          controller.close();
        }
      });
      incoming.on('error', (error) => {
        if (!ended) {
          ended = true;
          controller.error(error);
        }
      });
    },
    pull: () => {
      incoming.resume();
    },
    cancel: () => {
      ended = true;
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

  // Concatenate rather than resolve, so a `//host/` target cannot parse as another origin.
  return new Request(new URL(`${origin}${incoming.url ?? '/'}`), init);
};

const writeWebResponse = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
};

/**
 * Serves a runner over `node:http`. Bun and Workers do not need this: pass `runner.fetch` to
 * a host-owned Effect execution root. The host must keep the runner scope alive.
 */
const serveAgentRunner = (
  runner: AgentRunner,
  { host = '127.0.0.1', port }: ServeAgentRunnerOptions,
): Effect.Effect<ServedAgentRunner, RunnerServerError, Scope.Scope> =>
  Effect.gen(function* () {
    let origin = '';
    const requests = new Set<Promise<void>>();

    const respond = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
      try {
        const exit = await Effect.runPromiseExit(runner.fetch(toWebRequest(incoming, origin)));

        if (Exit.isFailure(exit)) {
          outgoing.writeHead(500);
          outgoing.end();

          return;
        }

        await writeWebResponse(exit.value, outgoing);
      } catch (error) {
        console.error('[attest-client] request failed:', error);

        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      }
    };

    const server = createServer((incoming, outgoing) => {
      const pending = respond(incoming, outgoing);
      requests.add(pending);
      void pending.finally(() => requests.delete(pending));
    });

    const cleanup: ListenerCleanup = {};

    const closed = yield* Effect.cached(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
            server.closeAllConnections();
          }),
        catch: (cause) => new RunnerServerError({ operation: 'close', cause }),
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => Promise.all([...requests]),
            catch: (cause) => new RunnerServerError({ operation: 'join', cause }),
          }),
        ),
        Effect.asVoid,
        Effect.timeout(12_000),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            cleanup.exit = exit;
          }),
        ),
      ),
    );

    yield* Effect.addFinalizer(() => Effect.asVoid(Effect.exit(closed)));
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, resolve);
        }),
      catch: (cause) => new RunnerServerError({ operation: 'listen', cause }),
    });

    const address = server.address();

    if (address === null || isString(address)) {
      return yield* new RunnerServerError({ operation: 'bind' });
    }

    origin = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${String(address.port)}`;

    return {
      url: origin,
      close: () => closed,
      cleanup,
    };
  });

export {
  serveAgentRunner,
  RunnerServerError,
  type ListenerCloseError,
  type ServeAgentRunnerOptions,
  type ServedAgentRunner,
};
