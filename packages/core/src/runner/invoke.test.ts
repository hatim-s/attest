import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { invokeAgent } from './invoke.js';
import type { InvokeOptions } from './types.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const CLI_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/cli-agent.cjs');
const HTTP_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/http-agent.cjs');

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01J9ZK7Q2M5X8W4V3T2R1QPN0M',
  case_id: 'invoke-test',
  input: {},
};

const options: InvokeOptions = {
  env: { PATH: process.env.PATH ?? '' },
  outputCapBytes: 1_024 * 1_024,
  terminationGraceMs: 100,
  timeoutMs: 1_000,
  workingDirectory: REPOSITORY_ROOT,
};

type CanonicalServer = { baseUrl: string; child: ChildProcess; closed: Promise<void> };

let server: CanonicalServer | undefined;

const startCanonicalServer = async (): Promise<CanonicalServer> => {
  const child = spawn(process.execPath, [HTTP_AGENT_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let standardOutput = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP fixture readiness timed out')), 2_000);
    child.once('error', reject);
    child.stdout?.on('data', (chunk: Buffer) => {
      standardOutput += chunk.toString('utf8');
      const match = /LISTENING (\d+)/.exec(standardOutput);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, child, closed };
};

const stopCanonicalServer = async (canonicalServer: CanonicalServer): Promise<void> => {
  const forceKill = setTimeout(() => canonicalServer.child.kill('SIGKILL'), 1_000);
  canonicalServer.child.kill('SIGTERM');
  await canonicalServer.closed;
  clearTimeout(forceKill);
};

const requireServer = (): CanonicalServer => {
  if (server === undefined) {
    throw new Error('Canonical server was not started');
  }
  return server;
};

beforeAll(async () => {
  server = await startCanonicalServer();
});

afterAll(async () => {
  if (server !== undefined) {
    await stopCanonicalServer(server);
  }
});

describe('invokeAgent', () => {
  it('retries retryable HTTP 5xx and records every attempt', async () => {
    const result = await invokeAgent(
      { type: 'http', url: `${requireServer().baseUrl}/status-500` },
      request,
      { ...options, retries: 1 },
    );

    expect(result.status).toBe('invocation_error');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((attempt) => attempt.status === 'invocation_error')).toBe(true);
  });

  it('does not retry HTTP 4xx', async () => {
    const result = await invokeAgent(
      { type: 'http', url: `${requireServer().baseUrl}/status-404` },
      request,
      { ...options, retries: 3 },
    );

    expect(result.attempts).toHaveLength(1);
  });

  it('does not retry cancellation', async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25);
    try {
      const result = await invokeAgent(
        { type: 'cli', command: [process.execPath, CLI_AGENT_PATH, '--behavior=hang'] },
        request,
        { ...options, retries: 2, signal: controller.signal },
      );

      expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'cancelled' } });
      expect(result.attempts).toHaveLength(1);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it('retries other CLI invocation errors and retains the final attempt', async () => {
    const result = await invokeAgent(
      { type: 'cli', command: [process.execPath, CLI_AGENT_PATH, '--behavior=nonzero-exit'] },
      request,
      { ...options, retries: 1 },
    );

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'nonzero_exit' } });
    expect(result.attempts).toHaveLength(2);
    expect(result.durationMs).toBe(result.attempts[1]?.durationMs);
  });

  it('retries schema-invalid envelopes and records them as invocation errors', async () => {
    const program = `process.stdout.write(JSON.stringify({ protocol: '${AGENT_PROTOCOL}' }));`;
    const result = await invokeAgent(
      { type: 'cli', command: [process.execPath, '-e', program] },
      request,
      { ...options, retries: 1 },
    );

    expect(result).toMatchObject({
      status: 'invocation_error',
      error: { code: 'invalid_envelope' },
    });
    expect(result.attempts).toHaveLength(2);
    expect(
      result.attempts.every(
        (attempt) =>
          attempt.status === 'invocation_error' && attempt.error.code === 'invalid_envelope',
      ),
    ).toBe(true);
  });

  it('does not retry valid agent error envelopes', async () => {
    const program = `process.stdout.write(JSON.stringify({ protocol: '${AGENT_PROTOCOL}', error: { message: 'agent failed' } }));`;
    const result = await invokeAgent(
      { type: 'cli', command: [process.execPath, '-e', program] },
      request,
      { ...options, retries: 2 },
    );

    expect(result).toMatchObject({ status: 'ok', report: { ok: true } });
    expect(result.attempts).toHaveLength(1);
  });
});
