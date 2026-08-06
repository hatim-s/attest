import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { invokeAgent } from './invoke.js';
import type { InvokeOptions } from './types.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const CLI_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/cli-agent.cjs');
const HTTP_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/http-agent.cjs');
const MARKER_PROBE_AGENT_PATH = join(
  REPOSITORY_ROOT,
  'packages/core/src/runner/fixtures/marker-probe-agent.cjs',
);

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
  // Generous: node startup under parallel-suite load must never eat the budget.
  timeoutMs: 8_000,
  workingDirectory: REPOSITORY_ROOT,
};

type CanonicalServer = { baseUrl: string; child: ChildProcess; closed: Promise<void> };

let server: CanonicalServer | undefined;
const canonicalServers = new Set<CanonicalServer>();

const startCanonicalServer = async (): Promise<CanonicalServer> => {
  const child = spawn(process.execPath, [HTTP_AGENT_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  // Register before waiting so afterEach tears down a fixture whose handshake fails.
  const canonicalServer: CanonicalServer = { baseUrl: '', child, closed };
  canonicalServers.add(canonicalServer);
  let standardOutput = '';
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) =>
      reject(new Error(`HTTP fixture exited before reporting readiness (${String(exitCode)}).`)),
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      standardOutput += chunk.toString('utf8');
      const match = /LISTENING (\d+)/.exec(standardOutput);
      if (match?.[1] !== undefined) {
        resolve(Number(match[1]));
      }
    });
  });
  canonicalServer.baseUrl = `http://127.0.0.1:${port}`;
  return canonicalServer;
};

const stopCanonicalServer = async (canonicalServer: CanonicalServer): Promise<void> => {
  const forceKill = setTimeout(() => canonicalServer.child.kill('SIGKILL'), 1_000);
  canonicalServer.child.kill('SIGTERM');
  await canonicalServer.closed;
  clearTimeout(forceKill);
  canonicalServers.delete(canonicalServer);
};

/** Starts a one-shot redirect endpoint to prove retry classification without changing the fixture. */
const startRedirectServer = async (status: number): Promise<{ server: Server; url: string }> => {
  const redirectServer = createServer((_request, response) => {
    response.statusCode = status;
    response.setHeader('location', 'http://127.0.0.1:1/not-followed');
    response.end(JSON.stringify({ redirect: status }));
  });
  await new Promise<void>((resolve, reject) => {
    redirectServer.once('error', reject);
    redirectServer.listen(0, '127.0.0.1', resolve);
  });
  const address = redirectServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Redirect fixture did not bind a TCP port');
  }
  return { server: redirectServer, url: `http://127.0.0.1:${String(address.port)}` };
};

const stopRedirectServer = async (redirectServer: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    redirectServer.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const requireServer = (): CanonicalServer => {
  if (server === undefined) {
    throw new Error('Canonical server was not started');
  }
  return server;
};

describe('invokeAgent', { timeout: 30_000 }, () => {
  afterEach(async () => {
    await Promise.all([...canonicalServers].map(stopCanonicalServer));
    server = undefined;
  });

  it('retries retryable HTTP 5xx and records every attempt', async () => {
    server = await startCanonicalServer();
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
    server = await startCanonicalServer();
    const result = await invokeAgent(
      { type: 'http', url: `${requireServer().baseUrl}/status-404` },
      request,
      { ...options, retries: 3 },
    );

    expect(result.attempts).toHaveLength(1);
  });

  it.each([302, 307, 308])('does not retry terminal HTTP %i redirects', async (status) => {
    const redirectServer = await startRedirectServer(status);
    try {
      const result = await invokeAgent({ type: 'http', url: redirectServer.url }, request, {
        ...options,
        retries: 3,
      });

      expect(result).toMatchObject({
        status: 'invocation_error',
        diagnostics: { httpStatus: status },
      });
      expect(result.attempts).toHaveLength(1);
    } finally {
      await stopRedirectServer(redirectServer.server);
    }
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
    const program = `process.stdout.write(JSON.stringify({ protocol: '${AGENT_PROTOCOL}', vendor_field: true }));`;
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
    expect(result.attempts.every((attempt) => attempt.rawExcerpt?.text.length)).toBeTruthy();
    expect(result.attempts.every((attempt) => attempt.warnings[0]?.code === 'unknown_field')).toBe(
      true,
    );
  });

  it('creates a fresh working directory for every retry attempt', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'attest-marker-probe-'));
    const statePath = join(stateDirectory, 'state');
    try {
      const result = await invokeAgent(
        { type: 'cli', command: [process.execPath, MARKER_PROBE_AGENT_PATH] },
        request,
        {
          outputCapBytes: options.outputCapBytes,
          retries: 1,
          terminationGraceMs: options.terminationGraceMs,
          timeoutMs: options.timeoutMs,
          env: { PATH: process.env.PATH ?? '', MARKER_PROBE_STATE_FILE: statePath },
        },
      );

      expect(result).toMatchObject({
        status: 'ok',
        report: { ok: true, value: { output: 'attempt isolated' } },
      });
      expect(result.attempts).toHaveLength(2);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
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
