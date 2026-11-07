import { createConnection } from 'node:net';
import * as Cause from 'effect/Cause';
import * as Fiber from 'effect/Fiber';
import { AgentInvocationError } from '../errors.js';
import * as Effect from 'effect/Effect';
import * as Scope from 'effect/Scope';
import * as Exit from 'effect/Exit';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  parseWithSchemaSync,
  AGENT_COMPLETION_PROTOCOL,
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  agentRequestSchema,
  parseAgentResponse,
  type AgentCompletion,
  type AgentRequest,
  type Artifact,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  completeCallbackAgent,
  createLoopbackCompletionReceiver,
  CallbackCleanupError,
  invokeCallbackAgent,
  type CallbackAgentResource,
  type CompletionReceiver,
} from '../adapters/callback/index.js';
import { enforceArtifactLimits } from '../internal/artifact-limits.js';
import { parseJson } from '../internal/json-value.js';
import type { InvocationAttempt } from '../types.js';
import { startLoopbackServer, type LoopbackServer } from './support/loopback-server.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const servers: LoopbackServer[] = [];

const receivers: CompletionReceiver[] = [];

const scopes: Scope.Closeable[] = [];

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: RUN_ID,
  case_id: 'case-1',
  input: { prompt: 'write a file' },
};

const receiver = async (
  bodyCapBytes = 1024 * 1024,
  listenPort?: number,
): Promise<CompletionReceiver> => {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);

  const created = await Effect.runPromise(
    Effect.provideService(
      createLoopbackCompletionReceiver({ bodyCapBytes, listenPort }),
      Scope.Scope,
      scope,
    ),
  );

  receivers.push(created);

  return created;
};

const startServer = async (
  handler: (incoming: IncomingMessage, response: ServerResponse) => void,
): Promise<string> => {
  const server = await startLoopbackServer(handler);
  servers.push(server);

  return server.url;
};

const readBody = async (incoming: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  // SAFETY: an IncomingMessage without a text encoding yields Buffer chunks.
  for await (const chunk of incoming as AsyncIterable<Buffer>) chunks.push(chunk);

  return Buffer.concat(chunks).toString('utf8');
};

const completion = (
  fields: Partial<Extract<AgentCompletion, { output: unknown }>> = {},
): AgentCompletion => ({
  protocol: AGENT_COMPLETION_PROTOCOL,
  run_id: RUN_ID,
  case_id: 'case-1',
  output: 'done',
  ...fields,
});

const postCompletion = (url: string, token: string, body: string): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });

const callbackAgent = (
  origin: string,
  overrides: Partial<CallbackAgentResource> = {},
  transport: Partial<CallbackAgentResource['transport']> = {},
): CallbackAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'async',
  name: 'Async',
  transport: {
    kind: 'callback',
    lifecycle: 'external',
    trigger: { url: `${origin}/trigger`, method: 'POST' },
    artifact_fetch: { url: `${origin}/artifacts/{{artifact_id}}`, method: 'GET' },
    trace_fetch: { url: `${origin}/traces/{{trace_ref}}`, method: 'GET' },
    ...transport,
  },
  ...overrides,
});

/**
 * A mock async agent: the trigger answers 202 and, unless told otherwise, posts `reply` to the
 * callback URL it was given. Records every trigger body and header.
 */
const startAsyncAgent = async (options: {
  reply?: (callback: { url: string; token: string }) => AgentCompletion | undefined;
  triggerStatus?: () => number;
  files?: Record<string, { body: Buffer; type?: string }>;
}) => {
  const triggers: { body: AgentRequest; headers: IncomingMessage['headers'] }[] = [];
  const fetched: string[] = [];

  const origin = await startServer((incoming, response) => {
    void (async () => {
      const path = new URL(incoming.url ?? '/', 'http://x').pathname;

      if (path === '/trigger') {
        const body = parseWithSchemaSync(agentRequestSchema, parseJson(await readBody(incoming)));
        triggers.push({ body, headers: incoming.headers });
        const status = options.triggerStatus?.() ?? 202;
        response.writeHead(status).end();
        const callback = body.callback;

        if (status !== 202 || callback === undefined) return;
        const reply = options.reply?.(callback);

        if (reply !== undefined) {
          await postCompletion(callback.url, callback.token, JSON.stringify(reply));
        }

        return;
      }

      fetched.push(decodeURIComponent(path));
      const file = options.files?.[decodeURIComponent(path)];

      if (file === undefined) {
        response.writeHead(404).end();

        return;
      }

      response.writeHead(200, { 'content-type': file.type ?? 'application/octet-stream' });
      response.end(file.body);
    })();
  });

  return { origin, triggers, fetched };
};

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((created) => Effect.runPromise(created.close())));
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('loopback completion receiver', () => {
  it('keeps serving completions after malformed request targets exceed its worker count', async () => {
    const created = await receiver();

    const registration = await Effect.runPromise(
      created.register({ runId: RUN_ID, caseId: 'case-1' }),
    );

    const url = new URL(registration.url);

    const responses = await Promise.all(
      Array.from(
        { length: 32 },
        () =>
          new Promise<string>((resolve, reject) => {
            const socket = createConnection(Number(url.port), '127.0.0.1');
            let response = '';
            socket.setEncoding('utf8');
            socket.setTimeout(2_000, () => socket.destroy());
            socket.on('data', (chunk: string) => {
              response += chunk;
            });
            socket.once('error', reject);
            socket.once('close', () => resolve(response));
            socket.once('connect', () => {
              socket.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
            });
          }),
      ),
    );

    const accepted = await fetch(registration.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(completion()),
      signal: AbortSignal.timeout(2_000),
    });

    expect(accepted.status).toBe(202);
    await expect(Effect.runPromise(registration.completion)).resolves.toMatchObject({
      output: 'done',
    });
    expect(responses).toHaveLength(32);

    for (const response of responses) expect(response).toMatch(/^HTTP\/1\.1 404 /u);
  });

  it('accepts one completion per registration and rejects bad tokens, unknown cases, repeats and oversized bodies', async () => {
    const created = await receiver(2048);

    const registration = await Effect.runPromise(
      created.register({ runId: RUN_ID, caseId: 'case-1' }),
    );

    const body = JSON.stringify(completion());

    expect(registration.token).toMatch(/^[\w-]{43}$/u);
    expect((await postCompletion(registration.url, 'wrong', body)).status).toBe(401);

    const unknown = registration.url.replace('/case-1', '/case-2');

    expect((await postCompletion(unknown, registration.token, body)).status).toBe(404);

    const oversized = JSON.stringify(completion({ output: 'x'.repeat(4096) }));

    expect((await postCompletion(registration.url, registration.token, oversized)).status).toBe(
      413,
    );

    const mismatched = JSON.stringify(completion({ case_id: 'case-2' }));

    expect((await postCompletion(registration.url, registration.token, mismatched)).status).toBe(
      400,
    );

    const accepted = await postCompletion(registration.url, registration.token, body);

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true });
    await expect(Effect.runPromise(registration.completion)).resolves.toMatchObject({
      output: 'done',
    });
    expect((await postCompletion(registration.url, registration.token, body)).status).toBe(409);
  });
  it('tells apart two cases that share a run and case id by their tokens', async () => {
    // Case ids are unique per test, so two tests in one run can wait on the same path.
    const created = await receiver();
    const first = await Effect.runPromise(created.register({ runId: RUN_ID, caseId: 'case-1' }));
    const second = await Effect.runPromise(created.register({ runId: RUN_ID, caseId: 'case-1' }));

    expect(second.url).toBe(first.url);

    const posted = await postCompletion(
      second.url,
      second.token,
      JSON.stringify(completion({ output: 'second' })),
    );

    expect(posted.status).toBe(202);
    await expect(Effect.runPromise(second.completion)).resolves.toMatchObject({ output: 'second' });

    await postCompletion(first.url, first.token, JSON.stringify(completion({ output: 'first' })));
    await expect(Effect.runPromise(first.completion)).resolves.toMatchObject({ output: 'first' });
  });
});

describe('native callback ownership', () => {
  it('shares lazy concurrent startup and keeps a pending sibling after release and duplicate receipt', async () => {
    const created = await receiver();

    const [first, second] = await Effect.runPromise(
      Effect.all(
        [
          created.register({ runId: RUN_ID, caseId: 'case-1' }),
          created.register({ runId: RUN_ID, caseId: 'case-1' }),
        ],
        { concurrency: 'unbounded' },
      ),
    );

    expect(first.url).toBe(second.url);
    expect(first.token).not.toBe(second.token);
    expect(
      (await postCompletion(first.url, first.token, JSON.stringify(completion()))).status,
    ).toBe(202);
    await Effect.runPromise(first.release());
    expect(
      (await postCompletion(first.url, first.token, JSON.stringify(completion()))).status,
    ).toBe(409);
    expect(
      (await postCompletion(second.url, second.token, JSON.stringify(completion()))).status,
    ).toBe(202);
    await expect(Effect.runPromise(second.completion)).resolves.toMatchObject({ output: 'done' });
  });

  it('close joins pending observations, refuses new admission and is idempotent', async () => {
    const created = await receiver();

    const registered = await Effect.runPromise(
      created.register({ runId: RUN_ID, caseId: 'case-1' }),
    );

    const observed = Effect.runPromise(Effect.exit(registered.completion));
    await Effect.runPromise(created.close());
    expect(Exit.isFailure(await observed)).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromise(Effect.exit(created.register({ runId: RUN_ID, caseId: 'later' }))),
      ),
    ).toBe(true);
    await Effect.runPromise(created.close());
  });

  it('does not cache a failed listener and can bind after the port becomes free', async () => {
    const blocker = await startLoopbackServer((_request, response) => response.end());
    const created = await receiver(1024, Number(new URL(blocker.url).port));
    expect(
      Exit.isFailure(
        await Effect.runPromise(Effect.exit(created.register({ runId: RUN_ID, caseId: 'case-1' }))),
      ),
    ).toBe(true);
    await blocker.close();

    const registered = await Effect.runPromise(
      created.register({ runId: RUN_ID, caseId: 'case-1' }),
    );

    expect(
      (await postCompletion(registered.url, registered.token, JSON.stringify(completion()))).status,
    ).toBe(202);
  });

  it('joins a stalled admitted request when release closes the idle listener', async () => {
    const created = await receiver();
    const entry = await Effect.runPromise(created.register({ runId: RUN_ID, caseId: 'case-1' }));
    const url = new URL(entry.url);
    const socket = createConnection(Number(url.port), '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.resume();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(
      `POST ${url.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${entry.token}\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{`,
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await Effect.runPromise(entry.release());
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it('bounds the lifetime of a stalled incoming body independently of socket activity', async () => {
    const created = await receiver();
    const entry = await Effect.runPromise(created.register({ runId: RUN_ID, caseId: 'case-1' }));
    const url = new URL(entry.url);
    const socket = createConnection(Number(url.port), '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.resume();
    const started = Date.now();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(
      `POST ${url.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${entry.token}\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{`,
    );
    await closed;
    expect(Date.now() - started).toBeLessThan(35_000);
    expect(socket.destroyed).toBe(true);
    await Effect.runPromise(entry.release());
  }, 40_000);

  it('redacts the registration token from failed trigger evidence', async () => {
    let secret = '';

    const origin = await startServer((incoming, response) => {
      void readBody(incoming).then((body) => {
        const parsed = parseWithSchemaSync(agentRequestSchema, parseJson(body));
        secret = parsed.callback?.token ?? '';
        response.writeHead(503).end(JSON.stringify({ secret }));
      });
    });

    const result = await Effect.runPromise(
      invokeCallbackAgent(callbackAgent(origin), request, { receiver: await receiver() }),
    );

    expect(secret).toHaveLength(43);
    expect(result.status === 'invocation_error' && result.error.code).toBe('http_status');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('records pre-dispatch cancellation without sending a trigger', async () => {
    let calls = 0;

    const origin = await startServer((_incoming, response) => {
      calls += 1;
      response.end();
    });

    const controller = new AbortController();
    controller.abort();

    const result = await Effect.runPromise(
      invokeCallbackAgent(callbackAgent(origin), request, {
        receiver: await receiver(),
        signal: controller.signal,
      }),
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('cancelled');
    expect(calls).toBe(0);
  });

  it('retains successful attempt evidence when foreign registration cleanup fails', async () => {
    const agent = await startAsyncAgent({});

    const result = await Effect.runPromise(
      Effect.exit(
        invokeCallbackAgent(callbackAgent(agent.origin), request, {
          receiver: {
            register: () =>
              Effect.succeed({
                url: 'http://127.0.0.1/completion',
                token: 'private-token-value',
                completion: Effect.succeed(completion()),
                release: () =>
                  Effect.fail(new AgentInvocationError('network', 'Release unconfirmed.')),
              }),
            close: () => Effect.void,
          },
        }),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);

    if (Exit.isSuccess(result)) throw new Error('Expected cleanup failure.');
    const failure = result.cause.reasons.find((reason) => reason._tag === 'Fail');
    expect(failure?._tag === 'Fail' && failure.error.cause).toMatchObject({
      success: { status: 'ok' },
    });
    expect(failure?._tag === 'Fail' && failure.error.applicationStarted).toBe(true);
    expect(failure?._tag === 'Fail' && failure.error).toBeInstanceOf(CallbackCleanupError);

    if (failure?._tag === 'Fail' && failure.error instanceof CallbackCleanupError)
      expect(failure.error.result).toMatchObject({ status: 'ok', attempts: [{ status: 'ok' }] });
  });

  it('preserves a primary defect and still releases the registration', async () => {
    const agent = await startAsyncAgent({});
    const defect = new Error('broken host invariant');
    let released = 0;

    const result = await Effect.runPromise(
      Effect.exit(
        invokeCallbackAgent(callbackAgent(agent.origin), request, {
          receiver: {
            register: () =>
              Effect.succeed({
                url: 'http://127.0.0.1/completion',
                token: 'private-token-value',
                completion: Effect.die(defect),
                release: () =>
                  Effect.sync(() => {
                    released += 1;
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(new AgentInvocationError('network', 'Release unconfirmed.')),
                    ),
                  ),
              }),
            close: () => Effect.void,
          },
        }),
      ),
    );

    expect(released).toBe(1);
    expect(
      Exit.isFailure(result) &&
        result.cause.reasons.some((reason) => reason._tag === 'Die' && reason.defect === defect),
    ).toBe(true);
  });

  it('interrupts the native invocation only after registration release joins', async () => {
    const agent = await startAsyncAgent({});
    let released = false;
    const registered = await receiver();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            invokeCallbackAgent(callbackAgent(agent.origin), request, {
              receiver: {
                register: (input) =>
                  registered.register(input).pipe(
                    Effect.map((entry) => ({
                      ...entry,
                      release: () =>
                        entry.release().pipe(
                          Effect.andThen(
                            Effect.sync(() => {
                              released = true;
                            }),
                          ),
                        ),
                    })),
                  ),
                close: () => registered.close(),
              },
            }),
          );

          yield* Effect.sleep(30);
          yield* Fiber.interrupt(fiber);

          return yield* Fiber.await(fiber);
        }),
      ),
    );

    expect(released).toBe(true);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
  });

  it('does not replay a trigger whose dispatch timed out even with an idempotency header', async () => {
    let calls = 0;

    const origin = await startServer(() => {
      calls += 1;
    });

    const result = await Effect.runPromise(
      invokeCallbackAgent(
        callbackAgent(
          origin,
          {
            timeouts: { attempt_ms: 80 },
            retry: { retries: 2, backoff: { kind: 'none' } },
          },
          { idempotency_header: 'idempotency-key' },
        ),
        request,
        { receiver: await receiver() },
      ),
    );

    expect(calls).toBe(1);
    expect(result.status === 'invocation_error' && result.error.code).toBe('timeout');
    expect(result.attempts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });
});

describe('callback agent adapter', () => {
  it('sends the envelope with its callback and returns inline artifacts from the completion', async () => {
    const inline: Artifact = {
      kind: 'inline',
      path: 'src/answer.ts',
      media_type: 'text/typescript',
      encoding: 'utf8',
      content: 'export const answer = 42;\n',
    };

    const agent = await startAsyncAgent({ reply: () => completion({ artifacts: [inline] }) });

    const result = await Effect.runPromise(
      invokeCallbackAgent(callbackAgent(agent.origin), request, {
        receiver: await receiver(),
      }),
    );

    expect(result.status).toBe('ok');
    expect(result.diagnostics.httpStatus).toBe(202);
    expect(result.status === 'ok' && result.report?.ok && result.report.value).toMatchObject({
      output: 'done',
      artifacts: [inline],
    });

    const [trigger] = agent.triggers;

    expect(trigger?.body).toMatchObject({ run_id: RUN_ID, case_id: 'case-1' });
    expect(trigger?.body.callback?.url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/attest/completions/${RUN_ID}/case-1$`, 'u'),
    );
  });

  it('fetches reference artifacts and the trace reference before handing back the envelope', async () => {
    const trace = { schema: 'attest.trace', trace_id: 't1', spans: [] };

    const agent = await startAsyncAgent({
      reply: () =>
        completion({
          trace_ref: 'trace/1',
          artifacts: [
            { kind: 'reference', path: 'notes.md', id: 'n 1' },
            { kind: 'reference', path: 'logo.bin', id: 'logo', media_type: 'image/png' },
          ],
        }),
      files: {
        '/artifacts/n 1': { body: Buffer.from('# Notes\n'), type: 'text/markdown; charset=utf-8' },
        '/artifacts/logo': { body: Buffer.from([0xff, 0x00, 0xfe]) },
        '/traces/trace/1': { body: Buffer.from(JSON.stringify(trace)) },
      },
    });

    const result = await Effect.runPromise(
      invokeCallbackAgent(callbackAgent(agent.origin), request, {
        receiver: await receiver(),
      }),
    );

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.raw).toEqual({
      protocol: AGENT_PROTOCOL,
      output: 'done',
      trace,
      artifacts: [
        {
          kind: 'inline',
          path: 'notes.md',
          media_type: 'text/markdown',
          encoding: 'utf8',
          content: '# Notes\n',
        },
        {
          kind: 'inline',
          path: 'logo.bin',
          media_type: 'image/png',
          encoding: 'base64',
          content: Buffer.from([0xff, 0x00, 0xfe]).toString('base64'),
        },
      ],
    });
  });

  it('times out when no completion arrives and releases the registration', async () => {
    const created = await receiver();
    // A second pending case keeps the listener up, so the released URL answers instead of refusing.
    const keeper = await Effect.runPromise(created.register({ runId: RUN_ID, caseId: 'keeper' }));
    let callback: { url: string; token: string } | undefined;

    const agent = await startAsyncAgent({
      reply: (given) => {
        callback = given;

        return undefined;
      },
    });

    const result = await Effect.runPromise(
      invokeCallbackAgent(callbackAgent(agent.origin, { timeouts: { attempt_ms: 200 } }), request, {
        receiver: created,
      }),
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('timeout');
    expect(result.diagnostics.httpStatus).toBe(202);

    const late = await postCompletion(
      callback?.url ?? '',
      callback?.token ?? '',
      JSON.stringify(completion()),
    );

    expect(late.status).toBe(404);
    await Effect.runPromise(keeper.release());
  });

  it('records cancellation and frees the registration so a late completion is refused', async () => {
    const controller = new AbortController();
    const created = await receiver();
    const keeper = await Effect.runPromise(created.register({ runId: RUN_ID, caseId: 'keeper' }));
    let callback: { url: string; token: string } | undefined;

    const agent = await startAsyncAgent({
      reply: (given) => {
        callback = given;
        controller.abort();

        return undefined;
      },
    });

    const result = await Effect.runPromise(
      invokeCallbackAgent(callbackAgent(agent.origin), request, {
        receiver: created,
        signal: controller.signal,
      }),
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('cancelled');

    const late = await postCompletion(
      callback?.url ?? '',
      callback?.token ?? '',
      JSON.stringify(completion()),
    );

    expect(late.status).toBe(404);
    await Effect.runPromise(keeper.release());
  });

  it('retries a 5xx trigger only when the agent names an idempotency header', async () => {
    const statuses = (): (() => number) => {
      let calls = 0;

      return () => (calls++ === 0 ? 503 : 202);
    };

    const retrying = await startAsyncAgent({
      triggerStatus: statuses(),
      reply: () => completion(),
    });

    const retried = await Effect.runPromise(
      invokeCallbackAgent(
        callbackAgent(
          retrying.origin,
          { retry: { retries: 1, backoff: { kind: 'none' } } },
          { idempotency_header: 'idempotency-key' },
        ),
        request,
        { receiver: await receiver() },
      ),
    );

    expect(retried.status).toBe('ok');
    expect(retried.attempts).toHaveLength(2);
    expect(retrying.triggers).toHaveLength(2);

    const keys = retrying.triggers.map((trigger) => trigger.headers['idempotency-key']);

    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(keys[1]).toBe(keys[0]);

    const single = await startAsyncAgent({ triggerStatus: statuses(), reply: () => completion() });

    const failed = await Effect.runPromise(
      invokeCallbackAgent(
        callbackAgent(single.origin, { retry: { retries: 1, backoff: { kind: 'none' } } }),
        request,
        { receiver: await receiver() },
      ),
    );

    expect(failed.status === 'invocation_error' && failed.error.code).toBe('http_status');
    expect(failed.diagnostics.httpStatus).toBe(503);
    expect(single.triggers).toHaveLength(1);
  });

  it('enforces artifact count, per-artifact and duplicate-path rules before building the envelope', async () => {
    const agent = await startAsyncAgent({
      files: { '/artifacts/big': { body: Buffer.alloc(64, 1) } },
    });

    const reference = (path: string, id: string): Artifact => ({ kind: 'reference', path, id });

    const overCount = await Effect.runPromise(
      completeCallbackAgent(
        callbackAgent(agent.origin, { limits: { artifact_count: 1 } }),
        completion({ artifacts: [reference('a', 'big'), reference('b', 'big')] }),
      ),
    );

    expect(overCount.status === 'invocation_error' && overCount.error.code).toBe(
      'output_cap_exceeded',
    );
    expect(agent.fetched).toEqual([]);

    const overSize = await Effect.runPromise(
      completeCallbackAgent(
        callbackAgent(agent.origin, { limits: { artifact_bytes: 32 } }),
        completion({ artifacts: [reference('a', 'big')] }),
      ),
    );

    expect(overSize.status === 'invocation_error' && overSize.error.code).toBe(
      'output_cap_exceeded',
    );

    const duplicate = await Effect.runPromise(
      completeCallbackAgent(
        callbackAgent(agent.origin),
        completion({ artifacts: [reference('a', 'big'), reference('a', 'big')] }),
      ),
    );

    expect(duplicate.status === 'invocation_error' && duplicate.error.code).toBe(
      'invalid_envelope',
    );

    const overTotal = await Effect.runPromise(
      completeCallbackAgent(
        callbackAgent(agent.origin, { limits: { total_artifact_bytes: 100 } }),
        completion({ artifacts: [reference('a', 'big'), reference('b', 'big')] }),
      ),
    );

    // The second fetch may only read the 36 bytes left of the total, so it stops mid-body.
    expect(overTotal.status === 'invocation_error' && overTotal.error.code).toBe(
      'output_cap_exceeded',
    );
    expect(overTotal.status === 'invocation_error' && overTotal.error.message).toContain('36-byte');
  });
});

describe('enforceArtifactLimits', () => {
  it('turns an over-limit response from any transport into a capped invocation error', () => {
    const inline = (path: string): Artifact => ({
      kind: 'inline',
      path,
      media_type: 'text/plain',
      encoding: 'utf8',
      content: 'x',
    });

    const response = {
      protocol: AGENT_PROTOCOL,
      output: 'done',
      artifacts: [inline('a'), inline('b')],
    };

    const attempt = {
      status: 'ok',
      raw: response,
      report: parseAgentResponse(response),
      diagnostics: { httpStatus: 200 },
      durationMs: 1,
      warnings: [],
    } satisfies InvocationAttempt;

    const result = { ...attempt, attempts: [attempt] };
    const capped = enforceArtifactLimits(result, { artifact_count: 1 });

    expect(capped.status === 'invocation_error' && capped.error.code).toBe('output_cap_exceeded');
    expect(capped.diagnostics.httpStatus).toBe(200);
    expect(capped.attempts).toEqual([capped.attempts[0]]);
    expect(capped.attempts[0]?.status).toBe('invocation_error');
    expect(enforceArtifactLimits(result, { artifact_count: 2 }).status).toBe('ok');
  });
});
