import * as Exit from 'effect/Exit';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Queue from 'effect/Queue';
import * as Semaphore from 'effect/Semaphore';
import { httpSync, withHttpCleanup } from '../http/http-effects.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseAgentCompletion, type AgentCompletion } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { parseJson } from '../../internal/json-value.js';

/** One case waiting for its completion. `release` stops accepting it and frees the slot. */
type CompletionRegistration = {
  url: string;
  token: string;
  completion: Effect.Effect<AgentCompletion, AgentInvocationError>;
  release(): Effect.Effect<void, AgentInvocationError>;
};

/**
 * Hands out callback URLs and tokens and delivers the completion posted to each. Local runs use
 * the loopback receiver below; a hosted runner supplies its own.
 */
type CompletionReceiver = {
  /** Aborting `signal` rejects the completion and releases the registration. */
  register(input: {
    runId: string;
    caseId: string;
    signal?: AbortSignal;
  }): Effect.Effect<CompletionRegistration, AgentInvocationError>;
  close(): Effect.Effect<void, AgentInvocationError>;
};

type LoopbackReceiverOptions = {
  /** Port to bind on 127.0.0.1; 0 or unset picks an ephemeral port. */
  listenPort?: number;
  /** Base URL the agent is told to post to, for a tunnel or proxy in front of the listener. */
  publicUrl?: string;
  bodyCapBytes: number;
};

/**
 * One registered case. Case ids are unique only within a test, so several entries can share a
 * path; the token picks the entry. Accepted entries stay after release so a repeated post with the
 * right token gets 409 instead of 404, which tells the agent its first delivery landed.
 */
type Entry = {
  key: string;
  tokenDigest: Buffer;
  state: 'pending' | 'accepted';
  completion: Deferred.Deferred<AgentCompletion, AgentInvocationError>;
  detach: () => void;
};

const COMPLETION_PATH = /^\/attest\/completions\/(?<runId>[^/]+)\/(?<caseId>[^/]+)$/u;

/** Bounds slow or stalled posts; a completion body arrives in one request. */
const REQUEST_TIMEOUT_MS = 30_000;

const digest = (token: string): Buffer => createHash('sha256').update(token).digest();

const registrationKey = (runId: string, caseId: string): string => JSON.stringify([runId, caseId]);

/** Maps a request path to its registration key; malformed URLs and escapes match nothing. */
const pathKey = (url: string | undefined): string | undefined => {
  try {
    const groups = COMPLETION_PATH.exec(new URL(url ?? '/', 'http://127.0.0.1').pathname)?.groups;

    if (groups?.runId === undefined || groups.caseId === undefined) return undefined;

    return registrationKey(decodeURIComponent(groups.runId), decodeURIComponent(groups.caseId));
  } catch {
    return undefined;
  }
};

const reply = (
  response: ServerResponse,
  status: number,
  body: Record<string, string | boolean>,
  headers: OutgoingHttpHeaders = {},
): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

/** Observes one Node request body, removing listeners on every exit. */
const readBody = (request: IncomingMessage, capBytes: number) =>
  Effect.callback<string | null, AgentInvocationError>((resume) => {
    if (request.destroyed) {
      resume(Effect.fail(new AgentInvocationError('network', 'Completion body disconnected.')));

      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;

    const data = (chunk: Buffer): void => {
      bytes += chunk.byteLength;

      if (bytes > capBytes) resume(Effect.succeed(null));
      else chunks.push(chunk);
    };

    const end = (): void => resume(Effect.succeed(Buffer.concat(chunks, bytes).toString('utf8')));

    const error = (): void =>
      resume(Effect.fail(new AgentInvocationError('network', 'Completion body disconnected.')));

    if (Number(request.headers['content-length']) > capBytes) resume(Effect.succeed(null));
    else {
      request.on('data', data);
      request.once('end', end);
      request.once('error', error);
      request.once('aborted', error);
      request.once('close', error);
    }

    return Effect.sync(() => {
      request.off('data', data);
      request.off('end', end);
      request.off('error', error);
      request.off('aborted', error);
      request.off('close', error);
      request.pause();
    });
  });

const isJsonContentType = (value: string | undefined): boolean =>
  value?.split(';')[0]?.trim().toLowerCase() === 'application/json';

/**
 * Finds the entry whose token the request presents. Digests are compared in constant time, so
 * token length never shortcuts the comparison.
 */
const matchToken = (
  header: string | undefined,
  candidates: readonly Entry[],
): Entry | undefined => {
  const presented = /^Bearer (?<token>\S+)$/u.exec(header ?? '')?.groups?.token;

  if (presented === undefined) return undefined;
  const presentedDigest = digest(presented);

  return candidates.find((entry) => timingSafeEqual(presentedDigest, entry.tokenDigest));
};

/**
 * Receives completions on 127.0.0.1. The server starts on the first registration and closes when
 * no registration is pending. Tokens are 32 random bytes, valid for one accepted completion, and
 * never logged or echoed.
 */
const createLoopbackCompletionReceiver = Effect.fn('callback.makeReceiver')(function* (
  options: LoopbackReceiverOptions,
) {
  const entries = new Set<Entry>();
  const requests = new Map<IncomingMessage, Deferred.Deferred<void>>();

  const queue = yield* Queue.dropping<{
    request: IncomingMessage;
    response: ServerResponse;
    done: Deferred.Deferred<void>;
  }>(128);

  const lock = yield* Semaphore.make(1);
  const idle = yield* Queue.sliding<void>(1);
  const backgroundCleanup: Exit.Exit<void, AgentInvocationError>[] = [];
  let closeResult: Exit.Exit<void, AgentInvocationError> | undefined;
  let listener: { server: ReturnType<typeof createServer>; base: string } | undefined;
  let closed = false;

  const stopped = new AgentInvocationError(
    'network',
    'Completion registration is no longer pending.',
  );

  const handle = Effect.fn('callback.handle')(function* (
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const key = pathKey(request.url);

    if (key === undefined) {
      reply(response, 404, { error: 'not_found' });

      return;
    }

    if (request.method !== 'POST') {
      reply(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

      return;
    }

    const candidates = [...entries].filter((candidate) => candidate.key === key);

    if (candidates.length === 0) {
      reply(response, 404, { error: 'unknown_registration' });

      return;
    }

    const entry = matchToken(request.headers.authorization, candidates);

    if (entry === undefined) {
      reply(response, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer' });

      return;
    }

    if (entry.state === 'accepted') {
      reply(response, 409, { error: 'already_completed' });

      return;
    }

    if (!isJsonContentType(request.headers['content-type'])) {
      reply(response, 415, { error: 'content_type_must_be_application_json' });

      return;
    }

    const body = yield* readBody(request, options.bodyCapBytes);

    if (body === null) {
      reply(response, 413, { error: 'body_too_large' }, { connection: 'close' });
      request.destroy();

      return;
    }

    const candidate = yield* Effect.try(() => parseJson(body)).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          reply(response, 400, { error: 'malformed_json' });

          return undefined;
        }),
      ),
    );

    if (candidate === undefined) return;

    const parsed = parseAgentCompletion(candidate);

    if (!parsed.ok) {
      const issues = parsed.error
        .slice(0, 5)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ');

      reply(response, 400, { error: 'invalid_completion', message: issues });

      return;
    }

    const completion = parsed.value;

    if (registrationKey(completion.run_id, completion.case_id) !== key) {
      reply(response, 400, { error: 'run_or_case_id_mismatch' });

      return;
    }

    // The body read awaited, so the entry may have been released or completed in the meantime.
    if (!entries.has(entry)) {
      reply(response, 404, { error: 'unknown_registration' });

      return;
    }

    if (entry.state !== 'pending') {
      reply(response, 409, { error: 'already_completed' });

      return;
    }

    entry.state = 'accepted';
    reply(response, 202, { accepted: true });
    yield* Effect.callback<void>((resume) => {
      const done = (): void => resume(Effect.void);

      if (response.writableFinished || response.destroyed) done();
      else {
        response.once('finish', done);
        response.once('close', done);
      }

      return Effect.sync(() => {
        response.off('finish', done);
        response.off('close', done);
      });
    });
    yield* Deferred.succeed(entry.completion, completion);
  });

  // Node callbacks only publish observations. Scoped workers own all request execution.
  const workers: Fiber.Fiber<never, AgentInvocationError>[] = [];

  for (let index = 0; index < 16; index += 1) {
    workers.push(
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const { request, response, done } = yield* Queue.take(queue);
            yield* handle(request, response).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  if (!response.headersSent && !response.destroyed)
                    reply(response, 500, { error: 'internal_error' });
                  else response.destroy();
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  requests.delete(request);

                  if (!request.complete) request.destroy();
                  Deferred.doneUnsafe(done, Effect.void);
                }),
              ),
            );
          }),
        ),
      ),
    );
  }

  /** Closing joins Node's listener callback and every accepted socket before returning. */
  const stopServer = Effect.fn('callback.stopListener')(function* () {
    const current = listener;

    if (current === undefined) return;
    listener = undefined;
    const accepted = [...requests.values()];
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Install close observation before destroying connections, including on Bun.
        const closing = yield* Effect.forkScoped(
          Effect.callback<void, AgentInvocationError>((resume) => {
            const timer = setTimeout(
              () =>
                resume(
                  Effect.fail(
                    new AgentInvocationError(
                      'network',
                      'Completion listener close was not confirmed.',
                    ),
                  ),
                ),
              REQUEST_TIMEOUT_MS,
            );

            current.server.close((error) => {
              clearTimeout(timer);
              resume(
                error
                  ? Effect.fail(
                      new AgentInvocationError('network', 'Completion listener close failed.', {
                        cause: error,
                      }),
                    )
                  : Effect.void,
              );
            });

            return Effect.sync(() => clearTimeout(timer));
          }),
          { startImmediately: true },
        );

        yield* withHttpCleanup(Effect.void, [
          Effect.sync(() => current.server.closeAllConnections()),
          ...[...requests.keys()].map((request) => Effect.sync(() => request.destroy())),
          Fiber.join(closing),
          ...accepted.map((done) =>
            Deferred.await(done).pipe(
              Effect.timeoutOrElse({
                duration: REQUEST_TIMEOUT_MS,
                orElse: () =>
                  Effect.fail(
                    new AgentInvocationError(
                      'network',
                      'Completion request close was not confirmed.',
                    ),
                  ),
              }),
            ),
          ),
        ]);
      }),
    ).pipe(
      Effect.onExit((outcome) =>
        Effect.sync(() => {
          if (Exit.isFailure(outcome)) closed = true;
        }),
      ),
    );
  });

  const idleWorker = yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(idle);

        const outcome = yield* lock.withPermits(1)(
          Effect.exit(
            Effect.suspend(() =>
              [...entries].some((entry) => entry.state === 'pending') ? Effect.void : stopServer(),
            ),
          ),
        );

        if (Exit.isFailure(outcome)) backgroundCleanup.push(outcome);
      }),
    ),
  );

  /** Acquisition stays under the receiver lock; only a successful bind is cached. */
  const listen = Effect.fn('callback.listen')(function* () {
    if (listener !== undefined) return listener;

    const server = createServer((request, response) => {
      const done = Deferred.makeUnsafe<void>();
      requests.set(request, done);

      if (closed || !Queue.offerUnsafe(queue, { request, response, done })) {
        requests.delete(request);
        reply(response, 503, { error: 'internal_error' }, { connection: 'close' });
        request.destroy();

        return;
      }

      // The timer starts at admission, including time queued behind other bodies.
      const timer = setTimeout(() => request.destroy(), REQUEST_TIMEOUT_MS);
      response.once('close', () => clearTimeout(timer));
    });

    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = REQUEST_TIMEOUT_MS;
    yield* Effect.callback<void, AgentInvocationError>((resume) => {
      const error = (): void =>
        resume(
          Effect.fail(
            new AgentInvocationError('network', 'The completion receiver could not listen.'),
          ),
        );

      server.once('error', error);
      server.listen(options.listenPort ?? 0, '127.0.0.1', () => resume(Effect.void));

      return Effect.sync(() => server.off('error', error));
    });
    // SAFETY: a TCP listener reports AddressInfo, never a pipe name.
    const { port } = server.address() as AddressInfo;
    listener = {
      server,
      base: (options.publicUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/u, ''),
    };

    return listener;
  });

  /** The lock serializes startup, idle shutdown and admission; failed listens are never cached. */
  const register: CompletionReceiver['register'] = (input) =>
    lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { runId, caseId, signal } = input;

          if (closed || signal?.aborted) return yield* Effect.fail(stopped);
          const completion = yield* Deferred.make<AgentCompletion, AgentInvocationError>();
          const token = yield* httpSync(() => randomBytes(32).toString('base64url'));

          const entry: Entry = {
            key: registrationKey(runId, caseId),
            tokenDigest: digest(token),
            state: 'pending',
            completion,
            detach: () => undefined,
          };

          const abort = (): void => {
            if (entry.state !== 'pending') return;
            entries.delete(entry);
            Deferred.doneUnsafe(completion, Effect.fail(stopped));
            Queue.offerUnsafe(idle, undefined);
          };

          entry.detach = () => signal?.removeEventListener('abort', abort);
          signal?.addEventListener('abort', abort, { once: true });
          entries.add(entry);

          if (signal?.aborted) abort();
          const started = yield* Effect.result(listen());

          if (started._tag === 'Failure') {
            entry.detach();
            entries.delete(entry);
            yield* Deferred.fail(completion, stopped);

            return yield* Effect.fail(started.failure);
          }

          /** Releasing one case leaves pending siblings and accepted duplicate receipts intact. */
          const release = () =>
            lock.withPermits(1)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* withHttpCleanup(Effect.void, [
                    Effect.sync(entry.detach),
                    Effect.sync(() => {
                      if (entry.state === 'pending') {
                        entries.delete(entry);
                        Deferred.doneUnsafe(completion, Effect.fail(stopped));
                      }
                    }),
                    Effect.suspend(() =>
                      [...entries].some((candidate) => candidate.state === 'pending')
                        ? Effect.void
                        : stopServer(),
                    ),
                  ]);
                }),
              ),
            );

          return {
            url: `${started.success.base}/attest/completions/${encodeURIComponent(runId)}/${encodeURIComponent(caseId)}`,
            token,
            completion: Deferred.await(completion),
            release,
          };
        }),
      ),
    );

  const close: CompletionReceiver['close'] = () =>
    lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closeResult !== undefined) return yield* closeResult;
          closed = true;

          // Each cleanup is captured separately so a failed listener close cannot skip worker joins.
          const cleanup = [
            ...[...entries].flatMap((entry) => [
              Effect.sync(entry.detach),
              Effect.sync(() => Deferred.doneUnsafe(entry.completion, Effect.fail(stopped))),
            ]),
            Effect.sync(() => entries.clear()),
            stopServer(),
            Fiber.interrupt(idleWorker),
            ...backgroundCleanup,
            ...workers.map((worker) =>
              Fiber.interrupt(worker).pipe(
                Effect.andThen(Fiber.await(worker)),
                Effect.flatMap((exit) =>
                  Exit.isFailure(exit) &&
                  exit.cause.reasons.some((reason) => reason._tag !== 'Interrupt')
                    ? Effect.failCause(exit.cause)
                    : Effect.void,
                ),
              ),
            ),
          ];

          closeResult = yield* Effect.exit(withHttpCleanup(Effect.void, cleanup));

          return yield* closeResult;
        }),
      ),
    );

  // Scope fallback records all cleanup exits without throwing from a finalizer.
  const cleanup = yield* Deferred.make<Exit.Exit<void, AgentInvocationError>>();
  yield* Effect.addFinalizer(() =>
    Effect.exit(close()).pipe(Effect.flatMap((exit) => Deferred.succeed(cleanup, exit))),
  );

  return { register, close, cleanup: Deferred.await(cleanup) };
});

export { createLoopbackCompletionReceiver, type CompletionReceiver, type CompletionRegistration };
