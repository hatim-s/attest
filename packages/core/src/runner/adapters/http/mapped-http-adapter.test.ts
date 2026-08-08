import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_VERSION,
  type AgentRequest,
  type AgentResource,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { invokeMappedHttpAgent, type HttpAgentResource } from './mapped-http-adapter.js';

const servers: Server[] = [];
const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'mapped-http',
  input: { question: 'hello world' },
};

/** Starts a loopback fixture and returns its stable origin after the socket is listening. */
const startServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; server: Server }> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP fixture.');
  return { origin: `http://127.0.0.1:${String(address.port)}`, server };
};

const directAgent = (origin: string, overrides: Partial<AgentResource> = {}): HttpAgentResource =>
  ({
    schema: AGENT_RESOURCE_SCHEMA_VERSION,
    id: 'mapped',
    name: 'Mapped',
    transport: {
      kind: 'http',
      lifecycle: 'external',
      request: {
        url: `${origin}/invoke/{{input/question}}`,
        method: 'POST',
        headers: { 'x-input': '{{input/question}}' },
        query: { q: '{{input/question}}' },
        body: { prompt: '{{input/question}}' },
      },
      extraction: { result_pointer: '/data/result', error_pointer: '/error' },
    },
    ...overrides,
  }) as HttpAgentResource;

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('CLI2.10 mapped HTTP adapter', () => {
  it('maps path, query, headers, body, and extraction without shell or string coercion ambiguity', async () => {
    let observed: Record<string, unknown> = {};
    const fixture = await startServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        observed = {
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          header: incoming.headers['x-input'],
          url: incoming.url,
        };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: { result: { answer: 42 } } }));
      });
    });

    const result = await invokeMappedHttpAgent(directAgent(fixture.origin), request);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw result.error;
    expect(result.report?.ok).toBe(true);
    if (result.report?.ok !== true) throw new Error('Expected a valid extracted response.');
    expect(result.report.value).toMatchObject({
      protocol: AGENT_PROTOCOL,
      output: { answer: 42 },
    });
    expect(observed).toEqual({
      body: { prompt: 'hello world' },
      header: 'hello world',
      url: '/invoke/hello%20world?q=hello+world',
    });
  });

  it('caps hostile response bodies before parsing', async () => {
    const fixture = await startServer((_incoming, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { result: 'x'.repeat(2_000) } }));
    });
    const result = await invokeMappedHttpAgent(
      directAgent(fixture.origin, { limits: { response_bytes: 128 } }),
      request,
    );
    expect(result.status).toBe('invocation_error');
    if (result.status !== 'invocation_error') throw new Error('Expected cap error.');
    expect(result.error.code).toBe('output_cap_exceeded');
    expect(result.rawExcerpt?.truncated).toBe(true);
  });

  it('retries an idempotent submission, keeps one key, and polls with bounded Retry-After', async () => {
    let submissions = 0;
    let polls = 0;
    const keys: string[] = [];
    const fixture = await startServer((incoming, response) => {
      response.setHeader('content-type', 'application/json');
      if (incoming.url === '/submit') {
        submissions += 1;
        keys.push(String(incoming.headers['idempotency-key']));
        if (submissions === 1) {
          response.statusCode = 503;
          response.end();
          return;
        }
        response.end(JSON.stringify({ job: 'abc', status_url: '/jobs/abc' }));
        return;
      }
      polls += 1;
      response.setHeader('retry-after', '0');
      response.end(
        JSON.stringify(
          polls === 1 ? { status: 'running' } : { status: 'done', answer: 'terminal' },
        ),
      );
    });
    const agent: HttpAgentResource = {
      schema: AGENT_RESOURCE_SCHEMA_VERSION,
      id: 'poller',
      name: 'Poller',
      transport: {
        kind: 'polling',
        lifecycle: 'external',
        submit: { url: `${fixture.origin}/submit`, method: 'POST', body: { input: '{{input}}' } },
        idempotency_header: 'Idempotency-Key',
        job_id_pointer: '/job',
        status_url_pointer: '/status_url',
        status_pointer: '/status',
        success_values: ['done'],
        failure_values: ['failed'],
        extraction: { result_pointer: '/answer' },
        minimum_interval_ms: 1,
        maximum_interval_ms: 5,
      },
      retry: { retries: 1, backoff: { kind: 'none' } },
      timeouts: { attempt_ms: 2_000 },
    };

    const result = await invokeMappedHttpAgent(agent, request);
    expect(result.status).toBe('ok');
    expect(submissions).toBe(2);
    expect(polls).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toHaveLength(64);
  });

  it('does not retry submission without an idempotency header', async () => {
    let submissions = 0;
    const fixture = await startServer((_incoming, response) => {
      submissions += 1;
      response.statusCode = 503;
      response.end();
    });
    const base = directAgent(fixture.origin);
    const agent = {
      ...base,
      retry: { retries: 3, backoff: { kind: 'none' as const } },
      transport: {
        kind: 'polling' as const,
        lifecycle: 'external' as const,
        submit: { url: `${fixture.origin}/submit`, method: 'POST' as const },
        job_id_pointer: '/job',
        status_url_template: `${fixture.origin}/jobs/{{job_id}}`,
        status_pointer: '/status',
        success_values: ['done'],
        failure_values: ['failed'],
        extraction: { result_pointer: '/answer' },
        minimum_interval_ms: 1,
        maximum_interval_ms: 5,
      },
    };
    const result = await invokeMappedHttpAgent(agent, request);
    expect(result.status).toBe('invocation_error');
    expect(submissions).toBe(1);
  });

  it('rejects cross-origin status URLs and cancels a pending poll promptly', async () => {
    const second = await startServer((_incoming, response) => response.end('{}'));
    const first = await startServer((_incoming, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ job: 'abc', url: `${second.origin}/job` }));
    });
    const makeAgent = (statusPointer: boolean): HttpAgentResource => ({
      schema: AGENT_RESOURCE_SCHEMA_VERSION,
      id: 'poller',
      name: 'Poller',
      transport: {
        kind: 'polling',
        lifecycle: 'external',
        submit: { url: `${first.origin}/submit`, method: 'POST' },
        job_id_pointer: '/job',
        ...(statusPointer
          ? { status_url_pointer: '/url' }
          : { status_url_template: `${first.origin}/jobs/{{job_id}}` }),
        status_pointer: '/status',
        success_values: ['done'],
        failure_values: ['failed'],
        extraction: { result_pointer: '/answer' },
        minimum_interval_ms: 1_000,
        maximum_interval_ms: 1_000,
      },
    });

    const rejected = await invokeMappedHttpAgent(makeAgent(true), request);
    expect(rejected.status).toBe('invocation_error');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const cancelled = await invokeMappedHttpAgent(makeAgent(false), request, {
      signal: controller.signal,
    });
    expect(cancelled.status).toBe('invocation_error');
    if (cancelled.status !== 'invocation_error') throw new Error('Expected cancellation.');
    expect(cancelled.error.code).toBe('cancelled');
  });

  it('follows same-origin 307 redirects but rejects origin changes and prohibited URLs', async () => {
    const foreign = await startServer((_incoming, response) => response.end('{}'));
    const fixture = await startServer((incoming, response) => {
      if (incoming.url?.startsWith('/invoke/')) {
        response.statusCode = 307;
        response.setHeader(
          'location',
          incoming.headers['x-mode'] === 'foreign' ? `${foreign.origin}/target` : '/target',
        );
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { result: 'ok' } }));
    });
    expect((await invokeMappedHttpAgent(directAgent(fixture.origin), request)).status).toBe('ok');
    const foreignResult = await invokeMappedHttpAgent(directAgent(fixture.origin), request, {
      headers: { 'x-mode': 'foreign' },
    });
    expect(foreignResult.status).toBe('invocation_error');

    const prohibited = await invokeMappedHttpAgent(directAgent('http://169.254.169.254'), request);
    expect(prohibited.status).toBe('invocation_error');
  });
});
