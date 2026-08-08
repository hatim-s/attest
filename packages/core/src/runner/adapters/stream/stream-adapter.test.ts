import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_VERSION,
  type AgentRequest,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { invokeStreamingAgent, type StreamAgentResource } from './stream-adapter.js';

const servers: Server[] = [];
const listen = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address.');
  return `http://127.0.0.1:${String(address.port)}`;
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'stream',
  input: { prompt: 'ping' },
};

const agent = (
  origin: string,
  framing: 'sse' | 'jsonl',
  overrides: Partial<StreamAgentResource> = {},
): StreamAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_VERSION,
  id: 'stream',
  name: 'Stream',
  transport: {
    kind: 'stream',
    lifecycle: 'external',
    framing,
    request: { method: 'POST', url: `${origin}/stream`, body: '{{request}}' },
    terminal_pointer: '/type',
    terminal_values: ['result'],
    result_pointer: '/output',
  },
  timeouts: { attempt_ms: 2_000, idle_ms: 500 },
  ...overrides,
});

describe('HTTP streaming adapter', () => {
  it('extracts terminal SSE after heartbeats and accumulates explicit text chunks', async () => {
    const origin = await listen((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.write(': heartbeat\n\n');
      response.write('data: {"type":"delta","chunk":"hel"}\n\n');
      response.end('data: {"type":"result","chunk":"lo","token":"stream-secret"}\n\n');
    });
    const configured = agent(origin, 'sse');
    configured.transport.incremental_output_pointer = '/chunk';
    configured.transport.incremental_output_mode = 'text';
    configured.transport.result_pointer = '/missing';
    configured.redaction = { event_pointers: ['/token'] };
    const result = await invokeStreamingAgent(configured, request);
    expect(result.status).toBe('ok');
    if (result.status === 'ok' && result.report?.ok && 'output' in result.report.value) {
      expect(result.report.value.output).toBe('hello');
    }
    expect(result.rawExcerpt?.text).not.toContain('stream-secret');
    expect(result.rawExcerpt?.text).toContain('[REDACTED]');
  });

  it('extracts JSONL terminal results and rejects clean nonterminal close', async () => {
    const origin = await listen((requestMessage, response) => {
      response.setHeader('content-type', 'application/x-ndjson');
      response.end(
        requestMessage.url?.includes('missing')
          ? '{"type":"delta"}\n'
          : '{"type":"result","output":{"ok":true}}\n',
      );
    });
    const completed = await invokeStreamingAgent(agent(origin, 'jsonl'), request);
    expect(completed.status).toBe('ok');
    const missing = agent(origin, 'jsonl');
    missing.transport.request.url = `${origin}/missing`;
    const failed = await invokeStreamingAgent(missing, request);
    expect(failed.status).toBe('invocation_error');
    if (failed.status === 'invocation_error') expect(failed.error.code).toBe('invalid_envelope');
  });

  it('enforces line, event, aggregate, idle, and cancellation limits', async () => {
    const origin = await listen((_request, response) => {
      response.setHeader('content-type', 'application/x-ndjson');
      response.write('{"type":"delta","chunk":"0123456789"}\n');
    });
    const capped = agent(origin, 'jsonl', { limits: { event_bytes: 8 } });
    const capResult = await invokeStreamingAgent(capped, request);
    expect(capResult.status).toBe('invocation_error');
    if (capResult.status === 'invocation_error')
      expect(capResult.error.code).toBe('output_cap_exceeded');

    const controller = new AbortController();
    const pending = invokeStreamingAgent(agent(origin, 'jsonl'), request, {
      signal: controller.signal,
    });
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.status).toBe('invocation_error');
    if (cancelled.status === 'invocation_error') expect(cancelled.error.code).toBe('cancelled');
  });

  it('retries only before the first application event', async () => {
    let calls = 0;
    const origin = await listen((_request, response) => {
      calls += 1;
      response.setHeader('content-type', 'application/x-ndjson');
      if (calls === 1) {
        response.destroy();
        return;
      }
      response.end('{"type":"result","output":"done"}\n');
    });
    const configured = agent(origin, 'jsonl', {
      retry: { retries: 1, backoff: { kind: 'none' } },
    });
    expect((await invokeStreamingAgent(configured, request)).status).toBe('ok');
    expect(calls).toBe(2);

    calls = 0;
    const startedOrigin = await listen((_request, response) => {
      calls += 1;
      response.setHeader('content-type', 'application/x-ndjson');
      response.write('{"type":"delta"}\n');
      setImmediate(() => response.destroy());
    });
    const started = agent(startedOrigin, 'jsonl', {
      retry: { retries: 1, backoff: { kind: 'none' } },
    });
    expect((await invokeStreamingAgent(started, request)).status).toBe('invocation_error');
    expect(calls).toBe(1);
  });
});
