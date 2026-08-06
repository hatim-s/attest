import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { invokeHttpAgent } from './http-invoker.js';
import type { InvokeOptions } from './types.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CANONICAL_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/http-agent.cjs');
const servers = new Set<Server>();

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

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  servers.delete(server);
};

/** Starts a private edge server only for behavior absent from the canonical HTTP fixture. */
const startEdgeServer = async (
  handler: (response: ServerResponse) => void,
): Promise<{ server: Server; url: string }> => {
  const server = createServer((_incomingRequest, response) => handler(response));
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP server address.');
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
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
});

afterEach(async () => {
  await Promise.all([...servers].map(closeServer));
});

afterAll(async () => {
  if (canonicalAgentServer !== undefined) {
    await stopCanonicalAgentServer(canonicalAgentServer);
  }
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

  it.each([404, 500])('returns http_status for canonical HTTP %i', async (status) => {
    const attempt = await invoke(canonicalUrl(`status-${status}`));

    expect(attempt).toMatchObject({
      status: 'invocation_error',
      diagnostics: { httpStatus: status },
    });
    if (attempt.status === 'invocation_error') {
      expect(attempt.error.code).toBe('http_status');
      expect(attempt.error.message).toContain(String(status));
    }
  });

  it('returns network after a locally closed server refuses the connection', async () => {
    const { server, url } = await startEdgeServer((response) => response.end());
    await closeServer(server);

    const attempt = await invoke(url);

    expect(attempt).toMatchObject({ status: 'invocation_error', error: { code: 'network' } });
  });

  it('returns timeout for canonical /hang', async () => {
    const attempt = await invoke(canonicalUrl('hang'), { timeoutMs: 25 });

    expect(attempt).toMatchObject({ status: 'invocation_error', error: { code: 'timeout' } });
  });

  it('gives caller cancellation precedence when timeout also expires', async () => {
    const controller = new AbortController();
    const invocation = invoke(canonicalUrl('hang'), {
      timeoutMs: 1,
      signal: controller.signal,
    });
    controller.abort();

    const attempt = await invocation;
    expect(attempt).toMatchObject({ status: 'invocation_error', error: { code: 'cancelled' } });
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
    });
    expect(bytesServed).toBeLessThan(cap * 2);
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

  it('returns cancelled when the caller aborts canonical /hang', async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25);

    try {
      const attempt = await invoke(canonicalUrl('hang'), { signal: controller.signal });
      expect(attempt).toMatchObject({ status: 'invocation_error', error: { code: 'cancelled' } });
    } finally {
      clearTimeout(abortTimer);
    }
  });
});
