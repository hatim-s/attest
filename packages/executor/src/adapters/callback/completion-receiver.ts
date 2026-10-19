import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
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
  completion: Promise<AgentCompletion>;
  release(): void;
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
  }): Promise<CompletionRegistration>;
  close(): Promise<void>;
};

type LoopbackReceiverOptions = {
  /** Port to bind on 127.0.0.1; 0 or unset picks an ephemeral port. */
  listenPort?: number;
  /** Base URL the agent is told to post to, for a tunnel or proxy in front of the listener. */
  publicUrl?: string;
  bodyCapBytes: number;
};

/**
 * `accepted` entries stay after release so a repeated post with the right token gets 409 instead
 * of 404, which tells the agent its first delivery landed.
 */
type Entry =
  | {
      state: 'pending';
      tokenDigest: Buffer;
      resolve: (completion: AgentCompletion) => void;
      reject: (cause: Error) => void;
    }
  | { state: 'accepted'; tokenDigest: Buffer };

const COMPLETION_PATH = /^\/attest\/completions\/(?<runId>[^/]+)\/(?<caseId>[^/]+)$/u;

/** Bounds slow or stalled posts; a completion body arrives in one request. */
const REQUEST_TIMEOUT_MS = 30_000;

const digest = (token: string): Buffer => createHash('sha256').update(token).digest();

const registrationKey = (runId: string, caseId: string): string => JSON.stringify([runId, caseId]);

/** Maps a request path to its registration key; malformed escapes match nothing. */
const pathKey = (url: string | undefined): string | undefined => {
  const groups = COMPLETION_PATH.exec(new URL(url ?? '/', 'http://127.0.0.1').pathname)?.groups;

  if (groups?.runId === undefined || groups.caseId === undefined) return undefined;

  try {
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

/** Reads at most `capBytes` of the body; null means the cap was exceeded. */
const readBody = async (request: IncomingMessage, capBytes: number): Promise<string | null> => {
  const declared = Number(request.headers['content-length']);

  if (Number.isFinite(declared) && declared > capBytes) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;

  // SAFETY: an IncomingMessage without a text encoding yields Buffer chunks.
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength;

    if (bytes > capBytes) return null;
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, bytes).toString('utf8');
};

const isJsonContentType = (value: string | undefined): boolean =>
  value?.split(';')[0]?.trim().toLowerCase() === 'application/json';

/** Compares digests so token length never shortcuts the comparison. */
const tokenMatches = (header: string | undefined, expected: Buffer): boolean => {
  const presented = /^Bearer (?<token>\S+)$/u.exec(header ?? '')?.groups?.token;

  return presented !== undefined && timingSafeEqual(digest(presented), expected);
};

/**
 * Receives completions on 127.0.0.1. The server starts on the first registration and closes when
 * no registration is pending. Tokens are 32 random bytes, valid for one accepted completion, and
 * never logged or echoed.
 */
const createLoopbackCompletionReceiver = (options: LoopbackReceiverOptions): CompletionReceiver => {
  const entries = new Map<string, Entry>();
  let listener: Promise<{ server: Server; base: string }> | undefined;
  let closing: Promise<void> = Promise.resolve();

  const pendingCount = (): number =>
    [...entries.values()].filter((entry) => entry.state === 'pending').length;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const key = pathKey(request.url);

    if (key === undefined) {
      reply(response, 404, { error: 'not_found' });

      return;
    }

    if (request.method !== 'POST') {
      reply(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

      return;
    }

    const entry = entries.get(key);

    if (entry === undefined) {
      reply(response, 404, { error: 'unknown_registration' });

      return;
    }

    if (!tokenMatches(request.headers.authorization, entry.tokenDigest)) {
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

    const body = await readBody(request, options.bodyCapBytes);

    if (body === null) {
      reply(response, 413, { error: 'body_too_large' }, { connection: 'close' });
      request.destroy();

      return;
    }

    let candidate: ReturnType<typeof parseJson>;

    try {
      candidate = parseJson(body);
    } catch {
      reply(response, 400, { error: 'malformed_json' });

      return;
    }

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

    // The body read awaited, so another post may have been accepted in the meantime.
    const current = entries.get(key);

    if (current === undefined) {
      reply(response, 404, { error: 'unknown_registration' });

      return;
    }

    if (current.state !== 'pending') {
      reply(response, 409, { error: 'already_completed' });

      return;
    }

    entries.set(key, { state: 'accepted', tokenDigest: current.tokenDigest });
    current.resolve(completion);
    reply(response, 202, { accepted: true });
  };

  const listen = async (): Promise<{ server: Server; base: string }> => {
    await closing;

    const server = createServer((request, response) => {
      handle(request, response).catch(() => {
        if (!response.headersSent) reply(response, 500, { error: 'internal_error' });
        else response.destroy();
      });
    });

    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = REQUEST_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.listenPort ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    // SAFETY: a server listening on a TCP host reports an AddressInfo, never a pipe name.
    const { port } = server.address() as AddressInfo;
    const base = (options.publicUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/u, '');

    return { server, base };
  };

  /**
   * Stops the listener once its start settles, so a stop that races a start cannot leak a
   * server. A later registration starts a fresh listener after this finishes.
   */
  const stopServer = (): Promise<void> => {
    const current = listener;
    listener = undefined;

    if (current === undefined) return closing;

    closing = current.then(
      ({ server }) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
      () => undefined,
    );

    return closing;
  };

  const closeIfIdle = (): void => {
    if (pendingCount() === 0) void stopServer();
  };

  const register: CompletionReceiver['register'] = async ({ runId, caseId, signal }) => {
    signal?.throwIfAborted();
    const key = registrationKey(runId, caseId);

    if (entries.get(key)?.state === 'pending') {
      throw new AgentInvocationError(
        'network',
        `A completion for case ${caseId} is already awaited in this run.`,
      );
    }

    const token = randomBytes(32).toString('base64url');

    // The executor runs synchronously, so the entry exists before register awaits anything.
    const promise = new Promise<AgentCompletion>((resolve, reject) => {
      entries.set(key, { state: 'pending', tokenDigest: digest(token), resolve, reject });
    });

    // The caller may stop awaiting after release; a later rejection must not surface as unhandled.
    promise.catch(() => undefined);

    /** Drops a still-pending entry, rejecting its completion, and stops an idle listener. */
    const drop = (cause: Error): void => {
      const entry = entries.get(key);

      if (entry?.state === 'pending') {
        entries.delete(key);
        entry.reject(cause);
      }

      closeIfIdle();
    };

    const abort = (): void =>
      drop(signal?.reason instanceof Error ? signal.reason : new Error('Aborted.'));

    const release = (): void => {
      signal?.removeEventListener('abort', abort);
      drop(new Error('Completion registration was released.'));
    };

    signal?.addEventListener('abort', abort, { once: true });

    try {
      listener ??= listen();
      const { base } = await listener;
      const path = `/attest/completions/${encodeURIComponent(runId)}/${encodeURIComponent(caseId)}`;

      return { url: `${base}${path}`, token, completion: promise, release };
    } catch (error: unknown) {
      listener = undefined;
      release();
      throw new AgentInvocationError('network', 'The completion receiver could not listen.', {
        cause: error,
      });
    }
  };

  const close = async (): Promise<void> => {
    for (const entry of entries.values()) {
      if (entry.state === 'pending') entry.reject(new Error('Completion receiver closed.'));
    }

    entries.clear();
    await stopServer();
  };

  return { register, close };
};

export {
  createLoopbackCompletionReceiver,
  type CompletionReceiver,
  type CompletionRegistration,
  type LoopbackReceiverOptions,
};
