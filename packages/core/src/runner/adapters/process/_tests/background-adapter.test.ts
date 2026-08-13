import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';

import { AGENT_PROTOCOL, AGENT_RESOURCE_SCHEMA_ID, type AgentRequest } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { startBackgroundAgent, type BackgroundAgentResource } from '../background-adapter.js';

const fixture = resolve(import.meta.dirname, '../../../_tests/fixtures/background-agent.cjs');

const freePort = async (): Promise<number> => {
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
};

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'probe',
  input: { ping: true },
};

const agent = (
  port: number,
  readiness: BackgroundAgentResource['transport']['readiness'],
): BackgroundAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'background',
  name: 'Background',
  transport: {
    kind: 'background_cli',
    lifecycle: 'per_run',
    start_argv: [process.execPath, fixture, String(port)],
    readiness,
    invoke: { method: 'POST', url: `http://127.0.0.1:${String(port)}/invoke`, body: '{{request}}' },
    extraction: { result_pointer: '/output' },
    shutdown: { method: 'POST', url: `http://127.0.0.1:${String(port)}/shutdown` },
    stop_timeout_ms: 100,
  },
  timeouts: { connect_ms: 2_000, attempt_ms: 2_000 },
});

describe('background process adapter', () => {
  it.each(['http', 'tcp', 'stderr'] as const)(
    'waits for %s readiness, invokes, and shuts down',
    async (kind) => {
      const port = await freePort();
      const readiness =
        kind === 'http'
          ? ({ kind, url: `http://127.0.0.1:${String(port)}/ready` } as const)
          : kind === 'tcp'
            ? ({ kind, host: '127.0.0.1', port } as const)
            : ({ kind, pattern: `READY ${String(port)}` } as const);
      const session = await startBackgroundAgent(agent(port, readiness), {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
      });
      const result = await session.invoke(request);
      expect(result.status).toBe('ok');
      if (result.status === 'ok' && result.report?.ok && 'output' in result.report.value) {
        expect(result.report.value.output).toEqual({ ping: true });
      }
      await session.close();
    },
  );

  it('bounds startup and rejects non-loopback managed endpoints', async () => {
    const port = await freePort();
    await expect(
      startBackgroundAgent(
        { ...agent(port, { kind: 'stderr', pattern: 'NEVER' }), timeouts: { connect_ms: 20 } },
        { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    await expect(
      startBackgroundAgent(
        {
          ...agent(port, { kind: 'tcp', host: '127.0.0.1', port }),
          transport: {
            ...agent(port, { kind: 'tcp', host: '127.0.0.1', port }).transport,
            invoke: { method: 'POST', url: 'https://example.com/invoke' },
          },
        },
        { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } },
      ),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('classifies the run deadline as timeout and still cleans up the service', async () => {
    const port = await freePort();
    const configured = agent(port, {
      kind: 'http',
      url: `http://127.0.0.1:${String(port)}/ready`,
    });
    configured.transport.start_argv.push('slow');
    configured.timeouts = { connect_ms: 2_000, attempt_ms: 3_000, run_ms: 1_000 };
    const session = await startBackgroundAgent(configured, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    });
    const result = await session.invoke(request);
    expect(result.status).toBe('invocation_error');
    if (result.status === 'invocation_error') expect(result.error.code).toBe('timeout');
    await session.close();
  });

  it('reports stderr-readiness exit immediately with bounded startup evidence', async () => {
    const port = await freePort();
    const configured = agent(port, { kind: 'stderr', pattern: 'NEVER' });
    configured.transport.start_argv.push('exit-before-ready');
    const started = Date.now();
    const failure: unknown = await startBackgroundAgent(configured, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'nonzero_exit' });
    if (failure === null || typeof failure !== 'object' || !('diagnostics' in failure)) {
      throw new Error('Expected bounded startup diagnostics.');
    }
    expect(failure.diagnostics).toMatchObject({ exitCode: 23 });
    expect(JSON.stringify(failure.diagnostics)).toContain('startup failed');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('preserves caller cancellation while waiting for stderr readiness', async () => {
    const port = await freePort();
    const configured = agent(port, { kind: 'stderr', pattern: 'NEVER' });
    configured.transport.start_argv.push('silent');
    const controller = new AbortController();
    const startup = startBackgroundAgent(configured, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(startup).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('keeps invoke and shutdown credentials endpoint-scoped', async () => {
    const processPort = await freePort();
    let invokeCredential: string | undefined;
    let shutdownCredential: string | undefined;
    let invokeQuery = '';
    let shutdownQuery = '';
    const invokeServer = createHttpServer((message, response) => {
      invokeCredential = message.headers['x-invoke'] as string | undefined;
      invokeQuery = message.url ?? '';
      response.setHeader('content-type', 'application/json');
      response.end('{"output":{"ok":true}}');
    });
    const shutdownServer = createHttpServer((message, response) => {
      shutdownCredential = message.headers['x-shutdown'] as string | undefined;
      shutdownQuery = message.url ?? '';
      response.writeHead(204).end();
    });
    await Promise.all(
      [invokeServer, shutdownServer].map(
        (server) =>
          new Promise<void>((resolveListen, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolveListen);
          }),
      ),
    );
    const invokeAddress = invokeServer.address();
    const shutdownAddress = shutdownServer.address();
    if (
      invokeAddress === null ||
      typeof invokeAddress === 'string' ||
      shutdownAddress === null ||
      typeof shutdownAddress === 'string'
    ) {
      throw new Error('Expected HTTP fixture addresses.');
    }
    const configured = agent(processPort, {
      kind: 'stderr',
      pattern: `READY ${String(processPort)}`,
    });
    configured.transport.invoke.url = `http://127.0.0.1:${String(invokeAddress.port)}/invoke`;
    configured.transport.shutdown = {
      method: 'POST',
      url: `http://127.0.0.1:${String(shutdownAddress.port)}/shutdown`,
    };
    try {
      const session = await startBackgroundAgent(configured, {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        invokeHeaders: { 'X-Invoke': 'invoke-secret' },
        invokeQuery: { invoke_token: 'invoke-query' },
        shutdownHeaders: { 'X-Shutdown': 'shutdown-secret' },
        shutdownQuery: { shutdown_token: 'shutdown-query' },
      });
      expect((await session.invoke(request)).status).toBe('ok');
      await session.close();
      expect(invokeCredential).toBe('invoke-secret');
      expect(invokeQuery).toContain('invoke_token=invoke-query');
      expect(invokeQuery).not.toContain('shutdown');
      expect(shutdownCredential).toBe('shutdown-secret');
      expect(shutdownQuery).toContain('shutdown_token=shutdown-query');
      expect(shutdownQuery).not.toContain('invoke');
    } finally {
      await Promise.all(
        [invokeServer, shutdownServer].map(
          (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
        ),
      );
    }
  });

  it('terminates descendants retained before graceful parent shutdown', async () => {
    const port = await freePort();
    const configured = agent(port, {
      kind: 'stderr',
      pattern: `READY ${String(port)}`,
    });
    configured.transport.start_argv.push('reparent-descendant');
    const session = await startBackgroundAgent(configured, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    });
    const result = await session.invoke(request);
    if (result.status !== 'ok' || !result.report?.ok || !('output' in result.report.value)) {
      throw new Error('Expected descendant fixture output.');
    }
    const descendantPid = (result.report.value.output as { descendant_pid: number }).descendant_pid;
    await session.close();
    await expect
      .poll(() => {
        try {
          process.kill(descendantPid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
});
