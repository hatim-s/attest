import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { invokeHttpAgent } from '../http-invoker.js';
import type { InvokeOptions } from '../types.js';
import { startLoopbackServer, type LoopbackServer } from './support/loopback-server.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CANONICAL_AGENT_PATH = join(
  REPOSITORY_ROOT,
  'conformance/src/_tests_/fixtures/fake-agents/http-agent.cjs',
);
const servers = new Set<LoopbackServer>();

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01J9ZK7Q2M5X8W4V3T2R1QPN0M',
  case_id: 'http-invoker-test',
  input: { question: 'hello' },
};

const options: InvokeOptions = {
  timeoutMs: 1_000,
  outputCapBytes: 1_024,
  env: {},
};

type CanonicalAgentServer = {
  baseUrl: string;
  child: ChildProcess;
  close: Promise<void>;
};

let canonicalAgentServer: CanonicalAgentServer | undefined;

/** Starts a private edge server only for behavior absent from the canonical HTTP fixture. */
const startEdgeServer = async (
  handler: (response: ServerResponse) => void,
): Promise<LoopbackServer> => {
  const server = await startLoopbackServer((_incomingRequest, response) => handler(response));
  servers.add(server);
  return server;
};

/** Spawns the shared conformance HTTP agent and parses its LISTENING readiness line. */
const startCanonicalAgentServer = async (): Promise<CanonicalAgentServer> => {
  const child = spawn(process.execPath, [CANONICAL_AGENT_PATH], {
    env: { ...process.env, AGENT_DRIP_MS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const close = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let standardOutput = '';
  const port = await new Promise<number>((resolve, reject) => {
    const readinessTimer = setTimeout(
      () => reject(new Error('Canonical HTTP agent did not report a listening port')),
      // Whole-suite parallel spawn storms can delay agent boot well past 2s.
      10_000,
    );
    const finish = (result: () => void): void => {
      clearTimeout(readinessTimer);
      result();
    };

    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (exitCode) =>
      finish(() => reject(new Error(`Canonical HTTP agent exited with ${exitCode}`))),
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      standardOutput += chunk.toString('utf8');
      const match = /(?:^|\n)LISTENING (\d+)/.exec(standardOutput);
      if (match?.[1] !== undefined) {
        finish(() => resolve(Number(match[1])));
      }
    });
  });

  return { baseUrl: `http://127.0.0.1:${port}`, child, close };
};

/** Stops the shared fixture gracefully and retains SIGKILL only as a bounded test fallback. */
const stopCanonicalAgentServer = async (server: CanonicalAgentServer): Promise<void> => {
  const forceKillTimer = setTimeout(() => server.child.kill('SIGKILL'), 1_000);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
  }
  await server.close;
  clearTimeout(forceKillTimer);
};

const invoke = (url: string, overrideOptions: Partial<InvokeOptions> = {}) =>
  invokeHttpAgent({ type: 'http', url }, request, { ...options, ...overrideOptions });

const canonicalUrl = (behavior: string): string => {
  if (canonicalAgentServer === undefined) {
    throw new Error('Canonical HTTP agent was not started');
  }

  return `${canonicalAgentServer.baseUrl}/${behavior}`;
};

beforeAll(async () => {
  canonicalAgentServer = await startCanonicalAgentServer();
}, 30_000);

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

afterAll(async () => {
  if (canonicalAgentServer !== undefined) await stopCanonicalAgentServer(canonicalAgentServer);
});

describe('invokeHttpAgent', () => {
  it('returns the raw parsed success envelope from canonical /happy', async () => {
    const attempt = await invoke(canonicalUrl('happy'));

    expect(attempt).toMatchObject({
      status: 'ok',
      raw: { protocol: AGENT_PROTOCOL, output: 'ok:http-invoker-test' },
      diagnostics: { httpStatus: 200 },
    });
  });

  it('keeps a 200 agent-error envelope as an unvalidated successful attempt', async () => {
    const { url } = await startEdgeServer((response) => {
      response.end(
        JSON.stringify({ protocol: AGENT_PROTOCOL, error: { message: 'agent failed' } }),
      );
    });

    const attempt = await invoke(url);

    expect(attempt).toMatchObject({
      status: 'ok',
      raw: { protocol: AGENT_PROTOCOL, error: { message: 'agent failed' } },
    });
  });

  it.each([
    [404, false],
    [500, false],
    [302, false],
    [307, false],
    [308, false],
    [302, true],
    [404, true],
  ])(
    'classifies HTTP %i (oversized body: %s) from headers without following redirects',
    async (status, oversized) => {
      const payload = oversized ? 'x'.repeat(options.outputCapBytes * 4) : '{}';
      const { url } = await startEdgeServer((response) => {
        response.statusCode = status;
        response.setHeader('content-length', String(Buffer.byteLength(payload)));
        response.setHeader('location', 'http://127.0.0.1:1/not-followed');
        response.end(payload);
      });

      const attempt = await invoke(url);

      expect(attempt).toMatchObject({
        status: 'invocation_error',
        error: { code: 'http_status' },
        diagnostics: { httpStatus: status },
      });
      if (attempt.status === 'invocation_error') {
        expect(attempt.error.message).toContain(String(status));
      }
    },
  );

  it('returns network after a locally closed server refuses the connection', async () => {
    const server = await startEdgeServer((response) => response.end());
    await server.close();
    servers.delete(server);
    const { url } = server;

    const attempt = await invoke(url);

    expect(attempt).toMatchObject({ status: 'invocation_error', error: { code: 'network' } });
  });

  it.each([
    { name: 'times out', timeoutMs: 25, abortAfterMs: undefined, code: 'timeout' },
    { name: 'cancels', timeoutMs: 1_000, abortAfterMs: 25, code: 'cancelled' },
    {
      name: 'prefers cancellation over an expired deadline',
      timeoutMs: 1,
      abortAfterMs: 0,
      code: 'cancelled',
    },
  ])('$name a hanging canonical request', async ({ timeoutMs, abortAfterMs, code }) => {
    const controller = new AbortController();
    const invocation = invoke(canonicalUrl('hang'), { timeoutMs, signal: controller.signal });
    // A zero delay aborts synchronously, before the one-millisecond deadline can fire.
    if (abortAfterMs === 0) controller.abort();
    const abortTimer =
      abortAfterMs === undefined || abortAfterMs === 0
        ? undefined
        : setTimeout(() => controller.abort(), abortAfterMs);
    try {
      expect(await invocation).toMatchObject({ status: 'invocation_error', error: { code } });
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it('aborts a streamed response as soon as its byte budget is exceeded', async () => {
    let bytesServed = 0;
    let responseClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const cap = 4_096;
    const chunk = 'x'.repeat(256);
    const { url } = await startEdgeServer((response) => {
      const interval = setInterval(() => {
        bytesServed += Buffer.byteLength(chunk);
        response.write(chunk);
      }, 1);
      response.once('close', () => {
        clearInterval(interval);
        responseClosed?.();
      });
    });

    const attempt = await invoke(url, { outputCapBytes: cap });
    await closed;

    expect(attempt).toMatchObject({
      status: 'invocation_error',
      error: { code: 'output_cap_exceeded' },
      rawExcerpt: { truncated: true },
    });
    expect(attempt.rawExcerpt?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bytesServed).toBeLessThan(cap * 2);
  });

  it('retains forced-truncated digest evidence when Content-Length exceeds the cap', async () => {
    const cap = 1_024;
    const payload = JSON.stringify({ output: 'x'.repeat(cap * 2) });
    const { url } = await startEdgeServer((response) => {
      response.setHeader('content-length', String(Buffer.byteLength(payload)));
      response.end(payload);
    });

    const attempt = await invoke(url, { outputCapBytes: cap });

    expect(attempt).toMatchObject({
      status: 'invocation_error',
      error: { code: 'output_cap_exceeded' },
      rawExcerpt: { truncated: true },
    });
    expect(attempt.rawExcerpt?.text.length).toBeLessThanOrEqual(4096);
    expect(attempt.rawExcerpt?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['malformed-json', 'partial-stdout'])(
    'returns invalid_envelope for canonical /%s',
    async (behavior) => {
      const attempt = await invoke(canonicalUrl(behavior));

      expect(attempt).toMatchObject({
        status: 'invocation_error',
        error: { code: 'invalid_envelope' },
        diagnostics: { httpStatus: 200 },
      });
    },
  );

  it('assembles canonical /slow-drip across response chunks', async () => {
    const attempt = await invoke(canonicalUrl('slow-drip'), { timeoutMs: 10_000 });

    expect(attempt).toMatchObject({
      status: 'ok',
      raw: { protocol: AGENT_PROTOCOL, output: 'ok:http-invoker-test' },
    });
  });
});
