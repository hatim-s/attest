import { openProcessSession } from './support/retained-process.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { AGENT_PROTOCOL, AGENT_RESOURCE_SCHEMA_ID, type AgentRequest } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  startJsonlBridgeAgent as nativeStart,
  type JsonlBridgeAgentResource,
} from '../jsonl-bridge-adapter.js';

/** Retains the native process scope for each existing lifecycle fixture. */
const startJsonlBridgeAgent = (...args: Parameters<typeof nativeStart>) =>
  openProcessSession(nativeStart(...args));

const fixture = resolve(import.meta.dirname, '../../../_tests_/fixtures/jsonl-bridge-agent.cjs');

const noReadFixture = resolve(
  import.meta.dirname,
  '../../../_tests_/fixtures/jsonl-no-read-agent.cjs',
);

const request = (caseId: string, input: AgentRequest['input']): AgentRequest => ({
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: caseId,
  input,
});

const agent = (overrides: Partial<JsonlBridgeAgentResource> = {}): JsonlBridgeAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'bridge',
  name: 'Bridge',
  transport: {
    kind: 'jsonl_bridge',
    lifecycle: 'per_run',
    argv: [process.execPath, fixture],
    concurrency: 'multiplexed',
    cancellation_grace_ms: 2_000,
  },
  timeouts: { attempt_ms: 2_000 },
  ...overrides,
});

describe('JSONL bridge adapter', () => {
  it.each(['before', 'during'] as const)(
    'rejects cancellation %s bridge startup',
    async (timing) => {
      let session: Awaited<ReturnType<typeof startJsonlBridgeAgent>> | undefined;
      const controller = new AbortController();

      if (timing === 'before') controller.abort();

      try {
        const startup = startJsonlBridgeAgent(agent(), {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? '' },
          signal: controller.signal,
          terminationGraceMs: 50,
        }).then((started) => {
          session = started;

          return started;
        });

        controller.abort();
        await expect(startup).rejects.toMatchObject({ code: 'cancelled' });
      } finally {
        await session?.close();
      }
    },
  );

  it('correlates multiplexed responses that complete out of order', async () => {
    const session = await startJsonlBridgeAgent(
      agent({ redaction: { event_pointers: ['/response/output/token'] } }),
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        terminationGraceMs: 50,
      },
    );

    try {
      const slow = session.invoke(request('slow', { delay_ms: 50, value: 'slow' }));

      const fast = session.invoke(
        request('fast', { delay_ms: 1, value: 'fast', token: 'bridge-secret' }),
      );

      const [slowResult, fastResult] = await Promise.all([slow, fast]);
      expect(slowResult.status).toBe('ok');
      expect(fastResult.status).toBe('ok');

      if (slowResult.status === 'ok' && fastResult.status === 'ok') {
        if (slowResult.report?.ok && 'output' in slowResult.report.value) {
          expect(slowResult.report.value.output).toMatchObject({ value: 'slow' });
        }

        if (fastResult.report?.ok && 'output' in fastResult.report.value) {
          expect(fastResult.report.value.output).toMatchObject({ value: 'fast' });
        }

        expect(fastResult.rawExcerpt?.text).not.toContain('bridge-secret');
        expect(fastResult.rawExcerpt?.text).toContain('[REDACTED]');
      }
    } finally {
      await session.close();
    }
  });

  it('uses in-band cancellation without disturbing another request', async () => {
    const session = await startJsonlBridgeAgent(agent(), {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      terminationGraceMs: 50,
    });

    const controller = new AbortController();

    try {
      const cancelled = session.invoke(request('cancel', { delay_ms: 500 }), controller.signal);
      const completed = session.invoke(request('keep', { delay_ms: 10 }));
      controller.abort();
      expect((await cancelled).status).toBe('invocation_error');
      expect((await completed).status).toBe('ok');
    } finally {
      await session.close();
    }
  });

  it('fails every outstanding request on non-JSON stdout or EOF', async () => {
    const protocol = await startJsonlBridgeAgent(agent(), {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      terminationGraceMs: 50,
    });

    expect((await protocol.invoke(request('bad', { action: 'non-json' }))).status).toBe(
      'invocation_error',
    );
    await protocol.close();

    const eof = await startJsonlBridgeAgent(agent(), {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      terminationGraceMs: 50,
    });

    const result = await eof.invoke(request('exit', { action: 'exit' }));
    expect(result.status).toBe('invocation_error');

    if (result.status === 'invocation_error') expect(result.error.code).toBe('nonzero_exit');
    await eof.close();
  });

  it('falls back to process termination when cancellation is ignored', async () => {
    const original = agent();

    const quickFallback = {
      ...original,
      transport: { ...original.transport, cancellation_grace_ms: 100 },
    };

    const session = await startJsonlBridgeAgent(quickFallback, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', IGNORE_CANCEL: '1' },
      terminationGraceMs: 50,
    });

    const controller = new AbortController();
    const result = session.invoke(request('cancel', { delay_ms: 5_000 }), controller.signal);
    controller.abort();
    const terminal = await result;
    expect(terminal.status).toBe('invocation_error');

    if (terminal.status === 'invocation_error') expect(terminal.error.code).toBe('cancelled');
    await session.close();
  });

  it('derives a bounded correlation id from a valid unbounded case id', async () => {
    const session = await startJsonlBridgeAgent(agent(), {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      terminationGraceMs: 50,
    });

    try {
      const result = await session.invoke(request('case-'.repeat(1_000), { value: 'bounded' }));
      expect(result.status).toBe('ok');
      const evidence = result.rawExcerpt?.text ?? '';
      const correlated = /"request_id":"([^"]+)"/u.exec(evidence)?.[1];
      expect(correlated).toMatch(/^req-[0-9a-z]+-[0-9a-f]{32}$/u);
      expect(correlated?.length).toBeLessThanOrEqual(256);
    } finally {
      await session.close();
    }
  });

  it('bounds cancellation when the peer never drains stdin', async () => {
    const configured = agent({
      transport: {
        kind: 'jsonl_bridge',
        lifecycle: 'per_run',
        argv: [process.execPath, noReadFixture],
        concurrency: 'multiplexed',
        cancellation_grace_ms: 50,
      },
      timeouts: { attempt_ms: 50 },
    });

    const session = await startJsonlBridgeAgent(configured, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      terminationGraceMs: 50,
    });

    const terminal = await Promise.race([
      session.invoke(request('blocked', { payload: 'x'.repeat(1024 * 1024) })),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('backpressure cancellation did not settle')), 500),
      ),
    ]);

    expect(terminal.status).toBe('invocation_error');

    if (terminal.status === 'invocation_error') expect(terminal.error.code).toBe('timeout');
    await session.close();
  });
});

it('handles automatic cleanup rejection before close observes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-jsonl-cleanup-'));
  await writeFile(join(directory, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });

  const moduleUrl = new URL('../jsonl-bridge-adapter.ts', import.meta.url).href;

  const configured = agent();

  const program = `
    import assert from 'node:assert/strict';
    import { startJsonlBridgeAgent as nativeStart } from ${JSON.stringify(moduleUrl)};
    import { openProcessSession } from ${JSON.stringify(new URL('./support/retained-process.ts', import.meta.url).href)};
    const startJsonlBridgeAgent = (...args) => openProcessSession(nativeStart(...args));
    process.env.PATH = ${JSON.stringify(directory)};
    const configured = ${JSON.stringify(configured)};
    configured.transport.argv = [process.execPath, '-e', 'setTimeout(() => process.exit(0), 100)'];
    const session = await startJsonlBridgeAgent(configured, { cwd: ${JSON.stringify(directory)}, env: { PATH: ${JSON.stringify(directory)} }, terminationGraceMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 700));
    await assert.rejects(session.close(), { code: 'network', message: 'Managed process cleanup could not be confirmed.' });
    console.log('cleanup rejection observed by close');
  `;

  try {
    // Bun loads current TypeScript in a separate process with its normal rejection policy.
    const { stdout } = await promisify(execFile)('bun', ['--eval', program], { timeout: 5000 });

    expect(stdout).toContain('cleanup rejection observed by close');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps startup cancellation primary when bridge cleanup is unconfirmed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-jsonl-cancel-'));
  await writeFile(join(directory, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  const controller = new AbortController();

  try {
    vi.stubEnv('PATH', directory);

    const startup = startJsonlBridgeAgent(agent(), {
      cwd: directory,
      env: { PATH: directory },
      signal: controller.signal,
      terminationGraceMs: 0,
    });

    controller.abort();
    await expect(startup).rejects.toMatchObject({
      code: 'cancelled',
      cause: { cleanupFailure: { code: 'network' } },
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
