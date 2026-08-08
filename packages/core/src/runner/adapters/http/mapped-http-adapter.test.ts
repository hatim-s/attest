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
      response_mode: 'mapped',
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

  it('maps a foreign error branch without retrying it as infrastructure failure', async () => {
    const fixture = await startServer((_incoming, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'agent declined', code: 'DECLINED' } }));
    });
    const result = await invokeMappedHttpAgent(directAgent(fixture.origin), request);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.report?.ok !== true) {
      throw new Error('Expected an extracted agent error.');
    }
    expect(result.report.value).toMatchObject({
      protocol: AGENT_PROTOCOL,
      error: { message: 'agent declined', code: 'DECLINED' },
    });
    expect(result.attempts).toHaveLength(1);
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
    expect(result.attempts.map(({ status }) => status)).toEqual(['invocation_error', 'ok']);
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
    const timedOut = await invokeMappedHttpAgent(
      { ...makeAgent(false), timeouts: { attempt_ms: 10 } },
      request,
    );
    expect(timedOut.status).toBe('invocation_error');
    if (timedOut.status !== 'invocation_error') throw new Error('Expected timeout.');
    expect(timedOut.error.code).toBe('timeout');
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

  it('redacts escaped response evidence and records an authored remote job id', async () => {
    const secret = 'quote"\\secret';
    const fixture = await startServer((_incoming, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { result: 'ok' }, echo: secret, job: 'remote-7' }));
    });
    const agent = directAgent(fixture.origin);
    agent.transport.extraction.remote_job_id_pointer = '/job';
    const result = await invokeMappedHttpAgent(agent, request, { secrets: [secret] });
    expect(result.status).toBe('ok');
    expect(result.rawExcerpt?.text).toContain('[REDACTED]');
    expect(result.rawExcerpt?.text).not.toContain(secret);
    expect(result.rawExcerpt?.text).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(result.diagnostics).toMatchObject({ remoteJobId: 'remote-7' });

    agent.transport.extraction.remote_job_id_pointer = '/missing';
    expect((await invokeMappedHttpAgent(agent, request)).diagnostics).not.toHaveProperty(
      'remoteJobId',
    );
    agent.transport.extraction.remote_job_id_pointer = '/data';
    expect(await invokeMappedHttpAgent(agent, request)).toMatchObject({
      status: 'invocation_error',
      error: { code: 'invalid_envelope' },
    });
  });

  it('performs zero network I/O for pre-cancelled, authority-templated, and oversized requests', async () => {
    let requests = 0;
    const fixture = await startServer((_incoming, response) => {
      requests += 1;
      response.end(JSON.stringify({ data: { result: 'unexpected' } }));
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await invokeMappedHttpAgent(directAgent(fixture.origin), request, {
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ status: 'invocation_error', error: { code: 'cancelled' } });

    const authority = directAgent(fixture.origin);
    if (authority.transport.kind !== 'http') throw new Error('Expected direct HTTP transport.');
    authority.transport.request.url = `http://{{input/question}}:${new URL(fixture.origin).port}/x`;
    expect((await invokeMappedHttpAgent(authority, request)).status).toBe('invocation_error');

    const oversized = directAgent(fixture.origin, { limits: { request_bytes: 80 } });
    if (oversized.transport.kind !== 'http') throw new Error('Expected direct HTTP transport.');
    oversized.transport.request.body = undefined;
    oversized.transport.request.query = { large: '{{input/question}}'.repeat(30) };
    expect((await invokeMappedHttpAgent(oversized, request)).status).toBe('invocation_error');
    expect(requests).toBe(0);
  });

  it('caps hostile non-2xx bodies and records real retry durations', async () => {
    let requests = 0;
    const fixture = await startServer((_incoming, response) => {
      requests += 1;
      setTimeout(() => {
        response.statusCode = requests === 1 ? 503 : 200;
        response.setHeader('content-type', 'application/json');
        response.end(
          requests === 1
            ? JSON.stringify({ error: 'x'.repeat(256) })
            : JSON.stringify({ data: { result: 'ok' } }),
        );
      }, 20);
    });
    const capped = await invokeMappedHttpAgent(
      directAgent(fixture.origin, { limits: { response_bytes: 64 } }),
      request,
    );
    expect(capped).toMatchObject({
      status: 'invocation_error',
      error: { code: 'output_cap_exceeded' },
    });

    requests = 0;
    const retried = await invokeMappedHttpAgent(
      directAgent(fixture.origin, {
        retry: { retries: 1, backoff: { kind: 'none' } },
        limits: { response_bytes: 1_024 },
      }),
      request,
    );
    expect(retried.status).toBe('ok');
    expect(retried.attempts[0]?.durationMs).toBeGreaterThanOrEqual(15);
  });

  it('validates polling before submit and fails authored terminal failures', async () => {
    let submissions = 0;
    const fixture = await startServer((incoming, response) => {
      response.setHeader('content-type', 'application/json');
      if (incoming.url === '/submit') {
        submissions += 1;
        response.end(JSON.stringify({ job: 'job-9', status_url: '/jobs/job-9' }));
        return;
      }
      response.end(JSON.stringify({ status: 'failed', error: { message: 'provider failed' } }));
    });
    const invalid = {
      schema: AGENT_RESOURCE_SCHEMA_VERSION,
      id: 'invalid-poller',
      name: 'Invalid poller',
      transport: {
        kind: 'polling',
        lifecycle: 'external',
        submit: { url: `${fixture.origin}/submit`, method: 'POST' },
        job_id_pointer: '/job',
        status_pointer: '/status',
        success_values: ['done'],
        failure_values: ['failed'],
        extraction: { result_pointer: '/answer' },
        minimum_interval_ms: 1,
        maximum_interval_ms: 2,
      },
    } as HttpAgentResource;
    expect((await invokeMappedHttpAgent(invalid, request)).status).toBe('invocation_error');
    expect(submissions).toBe(0);

    const valid = structuredClone(invalid);
    if (valid.transport.kind !== 'polling') throw new Error('Expected polling transport.');
    valid.transport.status_url_pointer = '/status_url';
    valid.transport.extraction.error_pointer = '/error';
    const failed = await invokeMappedHttpAgent(valid, request);
    expect(failed).toMatchObject({
      status: 'invocation_error',
      error: { message: 'provider failed' },
    });
    expect(failed.diagnostics).not.toHaveProperty('remoteJobId');
    expect(submissions).toBe(1);
  });

  it('serializes authored raw/form bodies byte for byte', async () => {
    let observed = '';
    const fixture = await startServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        observed = Buffer.concat(chunks).toString('utf8');
        response.end(JSON.stringify({ data: { result: 'ok' } }));
      });
    });
    const agent = directAgent(fixture.origin);
    if (agent.transport.kind !== 'http') throw new Error('Expected direct HTTP transport.');
    agent.transport.request.body = 'prompt={{input/question}}&mode=fast';
    agent.transport.request.body_encoding = 'raw';
    agent.transport.request.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await invokeMappedHttpAgent(agent, request)).status).toBe('ok');
    expect(observed).toBe('prompt=hello world&mode=fast');
  });
});
