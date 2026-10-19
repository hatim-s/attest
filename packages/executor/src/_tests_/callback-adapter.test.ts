import type { IncomingMessage, ServerResponse } from 'node:http';

import {
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

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: RUN_ID,
  case_id: 'case-1',
  input: { prompt: 'write a file' },
};

const receiver = (bodyCapBytes = 1024 * 1024): CompletionReceiver => {
  const created = createLoopbackCompletionReceiver({ bodyCapBytes });
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
        const body = agentRequestSchema.parse(parseJson(await readBody(incoming)));
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
  await Promise.all(receivers.splice(0).map((created) => created.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('loopback completion receiver', () => {
  it('accepts one completion per registration and rejects bad tokens, unknown cases, repeats and oversized bodies', async () => {
    const created = receiver(2048);
    const registration = await created.register({ runId: RUN_ID, caseId: 'case-1' });
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
    await expect(registration.completion).resolves.toMatchObject({ output: 'done' });
    expect((await postCompletion(registration.url, registration.token, body)).status).toBe(409);
  });
  it('tells apart two cases that share a run and case id by their tokens', async () => {
    // Case ids are unique per test, so two tests in one run can wait on the same path.
    const created = receiver();
    const first = await created.register({ runId: RUN_ID, caseId: 'case-1' });
    const second = await created.register({ runId: RUN_ID, caseId: 'case-1' });

    expect(second.url).toBe(first.url);

    const posted = await postCompletion(
      second.url,
      second.token,
      JSON.stringify(completion({ output: 'second' })),
    );

    expect(posted.status).toBe(202);
    await expect(second.completion).resolves.toMatchObject({ output: 'second' });

    await postCompletion(first.url, first.token, JSON.stringify(completion({ output: 'first' })));
    await expect(first.completion).resolves.toMatchObject({ output: 'first' });
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

    const result = await invokeCallbackAgent(callbackAgent(agent.origin), request, {
      receiver: receiver(),
    });

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

    const result = await invokeCallbackAgent(callbackAgent(agent.origin), request, {
      receiver: receiver(),
    });

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
    const created = receiver();
    // A second pending case keeps the listener up, so the released URL answers instead of refusing.
    const keeper = await created.register({ runId: RUN_ID, caseId: 'keeper' });
    let callback: { url: string; token: string } | undefined;

    const agent = await startAsyncAgent({
      reply: (given) => {
        callback = given;

        return undefined;
      },
    });

    const result = await invokeCallbackAgent(
      callbackAgent(agent.origin, { timeouts: { attempt_ms: 200 } }),
      request,
      { receiver: created },
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('timeout');
    expect(result.diagnostics.httpStatus).toBe(202);

    const late = await postCompletion(
      callback?.url ?? '',
      callback?.token ?? '',
      JSON.stringify(completion()),
    );

    expect(late.status).toBe(404);
    keeper.release();
  });

  it('records cancellation and frees the registration so a late completion is refused', async () => {
    const controller = new AbortController();
    const created = receiver();
    const keeper = await created.register({ runId: RUN_ID, caseId: 'keeper' });
    let callback: { url: string; token: string } | undefined;

    const agent = await startAsyncAgent({
      reply: (given) => {
        callback = given;
        controller.abort();

        return undefined;
      },
    });

    const result = await invokeCallbackAgent(callbackAgent(agent.origin), request, {
      receiver: created,
      signal: controller.signal,
    });

    expect(result.status === 'invocation_error' && result.error.code).toBe('cancelled');

    const late = await postCompletion(
      callback?.url ?? '',
      callback?.token ?? '',
      JSON.stringify(completion()),
    );

    expect(late.status).toBe(404);
    keeper.release();
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

    const retried = await invokeCallbackAgent(
      callbackAgent(
        retrying.origin,
        { retry: { retries: 1, backoff: { kind: 'none' } } },
        { idempotency_header: 'idempotency-key' },
      ),
      request,
      { receiver: receiver() },
    );

    expect(retried.status).toBe('ok');
    expect(retried.attempts).toHaveLength(2);
    expect(retrying.triggers).toHaveLength(2);

    const keys = retrying.triggers.map((trigger) => trigger.headers['idempotency-key']);

    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(keys[1]).toBe(keys[0]);

    const single = await startAsyncAgent({ triggerStatus: statuses(), reply: () => completion() });

    const failed = await invokeCallbackAgent(
      callbackAgent(single.origin, { retry: { retries: 1, backoff: { kind: 'none' } } }),
      request,
      { receiver: receiver() },
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

    const overCount = await completeCallbackAgent(
      callbackAgent(agent.origin, { limits: { artifact_count: 1 } }),
      completion({ artifacts: [reference('a', 'big'), reference('b', 'big')] }),
    );

    expect(overCount.status === 'invocation_error' && overCount.error.code).toBe(
      'output_cap_exceeded',
    );
    expect(agent.fetched).toEqual([]);

    const overSize = await completeCallbackAgent(
      callbackAgent(agent.origin, { limits: { artifact_bytes: 32 } }),
      completion({ artifacts: [reference('a', 'big')] }),
    );

    expect(overSize.status === 'invocation_error' && overSize.error.code).toBe(
      'output_cap_exceeded',
    );

    const duplicate = await completeCallbackAgent(
      callbackAgent(agent.origin),
      completion({ artifacts: [reference('a', 'big'), reference('a', 'big')] }),
    );

    expect(duplicate.status === 'invocation_error' && duplicate.error.code).toBe(
      'invalid_envelope',
    );

    const overTotal = await completeCallbackAgent(
      callbackAgent(agent.origin, { limits: { total_artifact_bytes: 100 } }),
      completion({ artifacts: [reference('a', 'big'), reference('b', 'big')] }),
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
