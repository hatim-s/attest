import { createServer } from 'node:net';
import { resolve } from 'node:path';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_VERSION,
  type AgentRequest,
} from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { startBackgroundAgent, type BackgroundAgentResource } from './background-adapter.js';

const fixture = resolve(import.meta.dirname, '../../fixtures/background-agent.cjs');

const freePort = async (): Promise<number> => {
  const server = createServer();
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
  schema: AGENT_RESOURCE_SCHEMA_VERSION,
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
});
