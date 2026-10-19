import {
  AGENT_PROTOCOL,
  TRACE_SCHEMA_ID,
  agentCompletionSchema,
  type Trace,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentRunner,
  type AgentHandler,
  type HandlerResult,
  type RunnerFailure,
} from '../index.js';
import { serveAgentRunner } from '../node.js';
import { startCompletionReceiver, type CompletionReceiver } from './support/completion-receiver.js';

const RUN_ID = '01J9Z3K4X5Y6Z7A8B9C0D1E2F3';

const TRIGGER_TOKEN = 'trigger-secret';

const receivers: CompletionReceiver[] = [];

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
});

const receiver = async (statuses: number[] = []): Promise<CompletionReceiver> => {
  const started = await startCompletionReceiver(statuses);

  receivers.push(started);

  return started;
};

const trigger = (
  callbackUrl: string,
  init: {
    runnerUrl?: string;
    headers?: Record<string, string>;
    body?: string;
    token?: string;
  } = {},
) =>
  new Request(init.runnerUrl ?? 'http://runner.test/', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TRIGGER_TOKEN}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    body:
      init.body ??
      JSON.stringify({
        protocol: AGENT_PROTOCOL,
        run_id: RUN_ID,
        case_id: 'case-1',
        input: 'hello',
        callback: { url: callbackUrl, token: init.token ?? 'secret-token' },
      }),
  });

const echo: AgentHandler = (invocation) =>
  Promise.resolve({ output: { echoed: invocation.input } });

describe('createAgentRunner', () => {
  it('accepts a trigger with 202 and posts the completion with the bearer token', async () => {
    const completions = await receiver();
    const runner = createAgentRunner({ handler: echo, triggerToken: TRIGGER_TOKEN });
    const served = await serveAgentRunner(runner, { port: 0 });

    try {
      const response = await fetch(trigger(completions.url, { runnerUrl: `${served.url}/` }));

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, run_id: RUN_ID, case_id: 'case-1' });
      await runner.drain();
    } finally {
      await served.close();
    }

    expect(completions.received).toHaveLength(1);
    expect(completions.received[0]?.authorization).toBe('Bearer secret-token');
    const completion = agentCompletionSchema.parse(JSON.parse(completions.received[0]?.body ?? ''));

    expect(completion).toEqual({
      protocol: 'attest.agent-completion',
      run_id: RUN_ID,
      case_id: 'case-1',
      output: { echoed: 'hello' },
    });
  });

  it('turns a handler throw into a handler_failed error completion', async () => {
    const completions = await receiver();
    const failures: RunnerFailure[] = [];

    const runner = createAgentRunner({
      triggerToken: TRIGGER_TOKEN,
      handler: () => Promise.reject(new Error('model offline')),
      onError: (failure) => failures.push(failure),
    });

    expect((await runner.fetch(trigger(completions.url))).status).toBe(202);
    await runner.drain();

    expect(JSON.parse(completions.received[0]?.body ?? '')).toMatchObject({
      error: { code: 'handler_failed', message: 'model offline' },
    });
    expect(failures.map((failure) => failure.kind)).toEqual(['handler_failed']);
  });

  it('retries a 503 from the receiver and stops after the 202', async () => {
    const completions = await receiver([503]);
    const failures: RunnerFailure[] = [];

    const runner = createAgentRunner({
      triggerToken: TRIGGER_TOKEN,
      handler: echo,
      onError: (failure) => failures.push(failure),
    });

    await runner.fetch(trigger(completions.url));
    await runner.drain();

    expect(completions.received).toHaveLength(2);
    expect(completions.received[1]?.body).toBe(completions.received[0]?.body);
    expect(failures).toEqual([]);
  });

  it('replaces a result the receiver would reject with an invalid_completion error', async () => {
    const completions = await receiver();
    const failures: RunnerFailure[] = [];

    const runner = createAgentRunner({
      triggerToken: TRIGGER_TOKEN,
      handler: () =>
        Promise.resolve({
          output: 'done',
          artifacts: [
            {
              kind: 'inline',
              path: '../escape.txt',
              media_type: 'text/plain',
              encoding: 'utf8',
              content: '',
            },
          ],
        }),
      onError: (failure) => failures.push(failure),
    });

    await runner.fetch(trigger(completions.url));
    await runner.drain();

    expect(JSON.parse(completions.received[0]?.body ?? '')).toMatchObject({
      error: { code: 'invalid_completion' },
    });
    expect(failures.map((failure) => failure.kind)).toEqual(['invalid_completion']);
  });

  it('runs a retried trigger once but a second registration of the same case again', async () => {
    const completions = await receiver();
    const tokens: string[] = [];
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));

    const runner = createAgentRunner({
      triggerToken: TRIGGER_TOKEN,
      handler: async (invocation) => {
        tokens.push(invocation.callback.token);
        await released;

        return { output: null };
      },
    });

    await runner.fetch(trigger(completions.url));
    await runner.fetch(trigger(completions.url));
    // Two tests in one run share the run and case id; only the callback token tells them apart.
    await runner.fetch(trigger(completions.url, { token: 'other-token' }));
    expect(runner.pending()).toBe(2);
    release();
    await runner.drain();

    expect(tokens).toEqual(['secret-token', 'other-token']);
    expect(completions.received.map((received) => received.authorization)).toEqual(
      expect.arrayContaining(['Bearer secret-token', 'Bearer other-token']),
    );
  });

  it('aborts running handlers on close, posts cancelled and refuses new triggers', async () => {
    const completions = await receiver();

    const runner = createAgentRunner({
      triggerToken: TRIGGER_TOKEN,
      handler: (_invocation, { signal }) =>
        new Promise<HandlerResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    await runner.fetch(trigger(completions.url));
    await runner.close();

    expect(JSON.parse(completions.received[0]?.body ?? '')).toMatchObject({
      error: { code: 'cancelled' },
    });
    expect((await runner.fetch(trigger(completions.url))).status).toBe(503);
  });

  it('posts invalid_completion for a trace that cannot be serialized', async () => {
    const completions = await receiver();
    const failures: RunnerFailure[] = [];
    const trace: Trace = { schema: TRACE_SCHEMA_ID, trace_id: 't', spans: [] };

    trace.self = trace;

    const runner = createAgentRunner({
      triggerToken: TRIGGER_TOKEN,
      handler: () => Promise.resolve({ output: 'done', trace }),
      onError: (failure) => failures.push(failure),
    });

    await runner.fetch(trigger(completions.url));
    // Before the fix this rejected inside the in-flight promise and Vitest failed the run.
    await runner.drain();

    expect(JSON.parse(completions.received[0]?.body ?? '')).toMatchObject({
      error: { code: 'invalid_completion' },
    });
    expect(failures.map((failure) => failure.kind)).toEqual(['invalid_completion']);
  });

  it('refuses triggers it must not run', async () => {
    const completions = await receiver();
    const runner = createAgentRunner({ handler: echo, triggerToken: TRIGGER_TOKEN });

    const statusOf = async (request: Request): Promise<number> =>
      (await runner.fetch(request)).status;

    expect(await statusOf(trigger(completions.url, { headers: { authorization: '' } }))).toBe(401);
    expect(
      await statusOf(trigger(completions.url, { headers: { authorization: 'Bearer wrong' } })),
    ).toBe(401);
    expect(
      await statusOf(trigger(completions.url, { headers: { 'content-type': 'text/plain' } })),
    ).toBe(415);
    expect(
      await statusOf(
        trigger(completions.url, {
          body: JSON.stringify({
            protocol: AGENT_PROTOCOL,
            run_id: RUN_ID,
            case_id: 'c',
            input: 1,
          }),
        }),
      ),
    ).toBe(400);
    expect(await statusOf(new Request('http://runner.test/'))).toBe(405);
    expect(await statusOf(new Request('http://runner.test/other', { method: 'POST' }))).toBe(404);
    expect(() => createAgentRunner({ handler: echo, triggerToken: '' })).toThrow(/triggerToken/u);
    expect(runner.pending()).toBe(0);
    expect(completions.received).toEqual([]);
  });
});
