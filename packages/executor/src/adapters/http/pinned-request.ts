import * as Effect from 'effect/Effect';
import { request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

import { AgentInvocationError } from '../../errors.js';
import { withHttpCleanup } from './http-effects.js';
import type { ResolvedHttpUrl } from './url-security.js';

/** What the server sent first: ordinary response headers or an accepted protocol upgrade. */
type PinnedResponse =
  | { kind: 'response'; response: IncomingMessage }
  | { kind: 'upgrade'; response: IncomingMessage; socket: Duplex; head: Buffer };

type PinnedRequestOptions = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Only WebSocket handshakes may transfer ownership of an upgraded socket. */
  allowUpgrade?: boolean;
  /** Aborts the request until the first response arrives. */
  signal: AbortSignal;
  /** Deadline for the first response or upgrade after the request is sent. */
  firstByteTimeoutMs: number;
  /** Optional socket inactivity deadline while connecting and waiting for headers. */
  connectTimeoutMs?: number;
  /** Each transport names its own failures. */
  errors: {
    aborted: () => AgentInvocationError;
    firstByteTimeout: () => AgentInvocationError;
    connectTimeout?: () => AgentInvocationError;
    failed: (cause: Error) => AgentInvocationError;
  };
};

/**
 * Sends a request to the address `resolveSafeHttpUrl` already validated, so a second DNS answer
 * can never redirect the connection. Resolves when the first response or upgrade arrives; the
 * caller then owns the response body and its own deadlines.
 */
const openPinnedRequest = (
  resolved: ResolvedHttpUrl,
  options: PinnedRequestOptions,
): Effect.Effect<PinnedResponse, AgentInvocationError> => {
  const { errors, signal } = options;

  if (signal.aborted) return Effect.fail(errors.aborted());
  const transport = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;

  return Effect.suspend(() => {
    let dispatched = false;

    const classify = (error: AgentInvocationError): AgentInvocationError =>
      dispatched
        ? new AgentInvocationError(error.code, error.message, {
            ...error,
            cause: error.cause,
            applicationStarted: true,
          })
        : error;

    let outgoing: ClientRequest | undefined;
    let received: PinnedResponse | undefined;
    let transferred = false;
    let removeAbort = (): void => {};

    const headers = Effect.callback<PinnedResponse, AgentInvocationError>((resume) => {
      const resolve = (value: PinnedResponse): void => {
        received = value;
        resume(Effect.succeed(value));
      };

      const reject = (error: AgentInvocationError): void => resume(Effect.fail(classify(error)));
      let settled = false;

      const request = transport(resolved.url, {
        method: options.method,
        headers: options.headers,
        lookup: (_hostname, _lookupOptions, callback) =>
          callback(null, resolved.address, resolved.family),
      });

      outgoing = request;

      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        outcome();
      };

      const failWith = (error: AgentInvocationError): void => {
        if (settled) return;
        request.destroy();
        settle(() => reject(error));
      };

      const abort = (): void => failWith(errors.aborted());

      const { connectTimeout } = errors;

      if (options.connectTimeoutMs !== undefined && connectTimeout !== undefined) {
        request.setTimeout(options.connectTimeoutMs, () => failWith(connectTimeout()));
      }

      request.once('socket', (socket) => {
        if (socket.connecting)
          socket.once('connect', () => {
            dispatched = true;
          });
        else dispatched = true;
      });
      request.once('finish', () => {
        dispatched = true;
      });
      request.once('response', (response) => {
        if (settled) {
          response.destroy();

          return;
        }

        // The response body owns its own idle deadline after headers arrive.
        request.setTimeout(0);
        settle(() => resolve({ kind: 'response', response }));
      });
      request.once('upgrade', (response, socket, head) => {
        if (settled) {
          response.destroy();
          socket.destroy();

          return;
        }

        if (options.allowUpgrade !== true) {
          socket.destroy();
          settle(() => reject(errors.failed(new Error('Unexpected HTTP protocol upgrade.'))));

          return;
        }

        settle(() => resolve({ kind: 'upgrade', response, socket, head }));
      });
      // Stays attached after settlement so a late socket error cannot become an uncaught event.
      request.on('error', (error) => settle(() => reject(errors.failed(error))));
      removeAbort = (): void => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });

      if (signal.aborted) {
        abort();

        return;
      }

      if (options.body !== undefined) request.write(options.body);
      request.end();

      return Effect.sync(() => {
        settled = true;
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.firstByteTimeoutMs,
        orElse: () => Effect.fail(classify(errors.firstByteTimeout())),
      }),
    );

    return withHttpCleanup(
      Effect.gen(function* () {
        const opened = yield* headers;
        transferred = true;

        return opened;
      }),
      [
        Effect.sync(() => removeAbort()),
        Effect.suspend(() => {
          if (transferred || outgoing === undefined) return Effect.void;
          const request = outgoing;

          return Effect.callback<void>((resume) => {
            const closed = (): void => resume(Effect.void);
            request.once('close', closed);
            received?.response.destroy();

            if (received?.kind === 'upgrade') received.socket.destroy();
            request.destroy();

            if (request.closed) closed();

            return Effect.sync(() => request.removeListener('close', closed));
          }).pipe(Effect.interruptible, Effect.timeout(100));
        }),
      ],
    );
  });
};

export { openPinnedRequest, type PinnedResponse };
