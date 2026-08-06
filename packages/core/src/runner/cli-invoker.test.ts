import type { AgentRequest, AgentTarget } from '@attest/contracts';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeCliAgent } from './cli-invoker.js';
import {
  acquireFixtureProcessSweepLock,
  sweepFixtureProcesses,
} from './test-support/fixture-processes.js';
import type { InvocationAttempt, InvokeOptions } from './types.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CANONICAL_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/cli-agent.cjs');
const PRIVATE_FIXTURE_DIRECTORY = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_SETTLE_MS = 700;
const FIXTURE_READINESS_TIMEOUT_MS = 30_000;
const FIXTURE_MARKERS = [
  CANONICAL_AGENT_PATH,
  join(PRIVATE_FIXTURE_DIRECTORY, 'envelope-then-exit-23-agent.cjs'),
  join(PRIVATE_FIXTURE_DIRECTORY, 'ignore-sigterm-agent.cjs'),
  join(PRIVATE_FIXTURE_DIRECTORY, 'marker-probe-agent.cjs'),
  join(PRIVATE_FIXTURE_DIRECTORY, 'normal-exit-orphan-agent.cjs'),
  join(PRIVATE_FIXTURE_DIRECTORY, 'session-escape-agent.cjs'),
  join(PRIVATE_FIXTURE_DIRECTORY, 'sigterm-forks-setsid-agent.cjs'),
  'attest-runner-',
] as const;

let fixtureEscapeAllowance: string | undefined;
let releaseFixtureProcessSweepLock: (() => Promise<void>) | undefined;

/** Records the one fixture whose post-snapshot escape is intentionally best-effort. */
const allowFixtureEscape = (reason: string): void => {
  fixtureEscapeAllowance = reason;
};

const request: AgentRequest = {
  protocol: 'attest.agent/v1alpha1',
  run_id: '01J9ZK7Q2M5X8W4V3T2R1QPN0M',
  case_id: 'cli-fixture',
  input: { question: 'hello' },
};

const createCanonicalTarget = (behavior: string): Extract<AgentTarget, { type: 'cli' }> => ({
  type: 'cli',
  command: [process.execPath, CANONICAL_AGENT_PATH, `--behavior=${behavior}`],
});

const createPrivateFixtureTarget = (
  fixtureName: string,
): Extract<AgentTarget, { type: 'cli' }> => ({
  type: 'cli',
  command: [process.execPath, join(PRIVATE_FIXTURE_DIRECTORY, fixtureName)],
});

const createInlineTarget = (program: string): Extract<AgentTarget, { type: 'cli' }> => ({
  type: 'cli',
  command: [process.execPath, '-e', program],
});

const createEnvironment = (values: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  ...values,
});

const createOptions = (overrides: Partial<InvokeOptions> = {}): InvokeOptions => ({
  // Node process startup can exceed 2s when the whole suite spawns in parallel;
  // failure-classification tests override this with deliberately small values.
  timeoutMs: 8_000,
  outputCapBytes: 1024 * 1024,
  env: createEnvironment(),
  workingDirectory: REPOSITORY_ROOT,
  ...overrides,
});

const requireInvocationError = (
  attempt: InvocationAttempt,
): Extract<InvocationAttempt, { status: 'invocation_error' }> => {
  expect(attempt.status).toBe('invocation_error');
  if (attempt.status !== 'invocation_error') {
    throw new Error('Expected an invocation error');
  }

  return attempt;
};

const isMissingProcessError = (error: unknown): boolean => {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
};

/** Polls kill(pid, 0) so process cleanup assertions tolerate asynchronous OS reaping. */
const waitForMissingProcessError = async (processId: number): Promise<unknown> => {
  const deadline = Date.now() + FIXTURE_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      if (isMissingProcessError(error)) {
        return error;
      }

      throw error;
    }

    await wait(25);
  }

  try {
    process.kill(processId, 0);
  } catch (error) {
    return error;
  }
  throw new Error(`Process ${processId} remained alive after cleanup`);
};

/** Waits for a hostile fixture to publish its PID before inspecting cleanup behavior. */
const readHeartbeat = async (heartbeatFile: string): Promise<string> => {
  const deadline = Date.now() + FIXTURE_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(heartbeatFile, 'utf8');
      if (contents.length > 0) {
        return contents;
      }
    } catch {
      // The fixture may not have created the heartbeat file yet.
    }

    await wait(25);
  }

  throw new Error(`Heartbeat file was not created: ${heartbeatFile}`);
};

/** Proves a killed process no longer appends to its heartbeat after transport cleanup returns. */
const expectHeartbeatStopped = async (heartbeatFile: string): Promise<void> => {
  const firstRead = await readHeartbeat(heartbeatFile);
  await wait(HEARTBEAT_SETTLE_MS);
  const secondRead = await readFile(heartbeatFile, 'utf8');
  expect(secondRead).toBe(firstRead);
};

/** Owns one temporary heartbeat directory so every hostile-process test cleans up its files. */
const withHeartbeatFile = async (run: (heartbeatFile: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-runner-'));
  try {
    await run(join(directory, 'heartbeat.log'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const parseHeartbeatProcessId = (contents: string): number => {
  const match = /^PID (\d+)/.exec(contents);
  if (match?.[1] === undefined) {
    throw new Error(`Heartbeat did not start with a PID: ${contents}`);
  }

  return Number(match[1]);
};

const parseStderrProcessId = (stderrExcerpt: string | undefined): number => {
  const match = /PID (\d+)/.exec(stderrExcerpt ?? '');
  if (match?.[1] === undefined) {
    throw new Error(`stderr did not contain a PID: ${stderrExcerpt ?? '<empty>'}`);
  }

  return Number(match[1]);
};

/**
 * Keeps the canonical orphan-child agent alive after it writes its response. The canonical
 * behavior intentionally lets its detached child outlive a normal parent exit; holding the
 * parent open makes that same behavior exercise timeout-tree cleanup without a duplicate fixture.
 */
const createCanonicalOrphanTimeoutTarget = (): Extract<AgentTarget, { type: 'cli' }> => {
  const wrapperProgram = `const originalWrite = process.stdout.write.bind(process.stdout); process.stdout.write = (...argumentsList) => { const result = originalWrite(...argumentsList); setInterval(() => undefined, 60000); return result; }; require(process.argv[1]);`;
  return {
    type: 'cli',
    command: [process.execPath, '-e', wrapperProgram, CANONICAL_AGENT_PATH],
  };
};

beforeEach(async () => {
  releaseFixtureProcessSweepLock = await acquireFixtureProcessSweepLock();
}, 30_000);

afterEach(async () => {
  try {
    const allowance = fixtureEscapeAllowance;
    fixtureEscapeAllowance = undefined;
    const killedProcessIds = sweepFixtureProcesses(FIXTURE_MARKERS);
    if (killedProcessIds.length > 0 && allowance === undefined) {
      throw new Error(
        `Fixture teardown killed unexpected processes: ${killedProcessIds.join(', ')}`,
      );
    }
  } finally {
    await releaseFixtureProcessSweepLock?.();
    releaseFixtureProcessSweepLock = undefined;
  }
});

describe('invokeCliAgent', { timeout: TEST_TIMEOUT_MS }, () => {
  it('writes the request and returns canonical parsed output', async () => {
    const attempt = await invokeCliAgent(createCanonicalTarget('happy'), request, createOptions());

    expect(attempt.status).toBe('ok');
    if (attempt.status === 'ok') {
      expect(attempt.raw).toEqual({ protocol: request.protocol, output: 'ok:cli-fixture' });
      expect(attempt.diagnostics.exitCode).toBe(0);
    }
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns an agent error envelope as unvalidated raw output', async () => {
    const program = `process.stdout.write(JSON.stringify({ protocol: '${request.protocol}', error: { message: 'failed', code: 'fixture_failure' } }));`;
    const attempt = await invokeCliAgent(createInlineTarget(program), request, createOptions());

    expect(attempt.status).toBe('ok');
    if (attempt.status === 'ok') {
      expect(attempt.raw).toMatchObject({ error: { code: 'fixture_failure' } });
    }
  });

  it('times out the canonical hanging agent within the grace allowance', async () => {
    const timeoutMs = 100;
    const startedAt = performance.now();
    const attempt = requireInvocationError(
      await invokeCliAgent(
        createCanonicalTarget('hang'),
        request,
        createOptions({ timeoutMs, terminationGraceMs: 500 }),
      ),
    );

    expect(attempt.error.code).toBe('timeout');
    expect(performance.now() - startedAt).toBeLessThan(timeoutMs + 2_500);
    expect(attempt.durationMs).toBeGreaterThanOrEqual(timeoutMs);
  });

  it('kills the canonical detached orphan after timeout', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const attempt = requireInvocationError(
        await invokeCliAgent(
          createCanonicalOrphanTimeoutTarget(),
          request,
          createOptions({
            // Generous timeout: the orphan must exist and heartbeat before the kill,
            // even under parallel-suite load, or the test proves nothing.
            timeoutMs: 5_000,
            terminationGraceMs: 500,
            env: createEnvironment({
              AGENT_BEHAVIOR: 'orphan-child',
              ORPHAN_HEARTBEAT_FILE: heartbeatFile,
            }),
          }),
        ),
      );

      expect(attempt.error.code).toBe('timeout');
      const processId = parseHeartbeatProcessId(await readHeartbeat(heartbeatFile));
      await expectHeartbeatStopped(heartbeatFile);
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('kills a grandchild that escaped into a new session', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const attempt = requireInvocationError(
        await invokeCliAgent(
          createPrivateFixtureTarget('session-escape-agent.cjs'),
          request,
          createOptions({
            timeoutMs: 300,
            terminationGraceMs: 500,
            env: createEnvironment({ ORPHAN_HEARTBEAT_FILE: heartbeatFile }),
          }),
        ),
      );

      expect(attempt.error.code).toBe('timeout');
      const processId = parseStderrProcessId(attempt.diagnostics.stderrExcerpt);
      await expectHeartbeatStopped(heartbeatFile);
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('sweeps a detached descendant created by a SIGTERM handler', async () => {
    allowFixtureEscape('A descendant can fork after the process-tree snapshot.');
    await withHeartbeatFile(async (heartbeatFile) => {
      const attempt = requireInvocationError(
        await invokeCliAgent(
          createPrivateFixtureTarget('sigterm-forks-setsid-agent.cjs'),
          request,
          createOptions({
            timeoutMs: 300,
            terminationGraceMs: 700,
            env: createEnvironment({ ORPHAN_HEARTBEAT_FILE: heartbeatFile }),
          }),
        ),
      );

      expect(attempt.error.code).toBe('timeout');
      const processId = parseHeartbeatProcessId(await readHeartbeat(heartbeatFile));
      await expectHeartbeatStopped(heartbeatFile);
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('sweeps a detached orphan after a normal zero exit', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const attempt = await invokeCliAgent(
        createPrivateFixtureTarget('normal-exit-orphan-agent.cjs'),
        request,
        createOptions({
          terminationGraceMs: 500,
          env: createEnvironment({ ORPHAN_HEARTBEAT_FILE: heartbeatFile }),
        }),
      );

      expect(attempt.status).toBe('ok');
      const processId = parseHeartbeatProcessId(await readHeartbeat(heartbeatFile));
      await expectHeartbeatStopped(heartbeatFile);
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('uses SIGKILL after the configured SIGTERM grace period', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const timeoutMs = 100;
      const terminationGraceMs = 500;
      const startedAt = performance.now();
      const attempt = requireInvocationError(
        await invokeCliAgent(
          createPrivateFixtureTarget('ignore-sigterm-agent.cjs'),
          request,
          createOptions({
            timeoutMs,
            terminationGraceMs,
            env: createEnvironment({ ORPHAN_HEARTBEAT_FILE: heartbeatFile }),
          }),
        ),
      );
      const elapsedMs = performance.now() - startedAt;
      const processId = parseStderrProcessId(attempt.diagnostics.stderrExcerpt);

      expect(attempt.error.code).toBe('timeout');
      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs + terminationGraceMs - 75);
      expect(elapsedMs).toBeLessThan(timeoutMs + terminationGraceMs + 2_000);
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('kills the canonical agent promptly when stdout exceeds the cap', async () => {
    const startedAt = performance.now();
    const attempt = requireInvocationError(
      await invokeCliAgent(
        createCanonicalTarget('huge-output'),
        request,
        createOptions({
          outputCapBytes: 128 * 1024,
          timeoutMs: 10_000,
          terminationGraceMs: 500,
          env: createEnvironment({ AGENT_HUGE_BYTES: String(512 * 1024) }),
        }),
      ),
    );

    expect(attempt.error.code).toBe('output_cap_exceeded');
    expect(attempt.rawExcerpt).toMatchObject({ truncated: true });
    expect(attempt.rawExcerpt?.text.length).toBeLessThanOrEqual(4096);
    expect(attempt.rawExcerpt?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  it('cancels through an AbortSignal and records duration', async () => {
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 50);
    try {
      const attempt = requireInvocationError(
        await invokeCliAgent(
          createCanonicalTarget('hang'),
          request,
          createOptions({ signal: abortController.signal, terminationGraceMs: 500 }),
        ),
      );

      expect(attempt.error.code).toBe('cancelled');
      expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it('gives caller cancellation precedence when timeout also expires', async () => {
    const abortController = new AbortController();
    const invocation = invokeCliAgent(
      createCanonicalTarget('hang'),
      request,
      createOptions({
        timeoutMs: 1,
        terminationGraceMs: 500,
        signal: abortController.signal,
      }),
    );
    abortController.abort();

    const attempt = requireInvocationError(await invocation);
    expect(attempt.error.code).toBe('cancelled');
  });

  it.each(['malformed-json', 'partial-stdout'])(
    'returns invalid_envelope for canonical %s output',
    async (behavior) => {
      const attempt = requireInvocationError(
        await invokeCliAgent(createCanonicalTarget(behavior), request, createOptions()),
      );

      expect(attempt.error.code).toBe('invalid_envelope');
      expect(attempt.rawExcerpt?.text.length).toBeGreaterThan(0);
      expect(attempt.warnings).toEqual([]);
    },
  );

  it('assembles canonical slow-drip output across streaming chunks', async () => {
    const attempt = await invokeCliAgent(
      createCanonicalTarget('slow-drip'),
      request,
      createOptions({
        env: createEnvironment({ AGENT_DRIP_MS: '1' }),
      }),
    );

    expect(attempt).toMatchObject({
      status: 'ok',
      raw: { protocol: request.protocol, output: 'ok:cli-fixture' },
    });
  });

  it('keeps canonical stderr noise out of the response envelope', async () => {
    const attempt = await invokeCliAgent(
      createCanonicalTarget('stderr-noise'),
      request,
      createOptions(),
    );

    expect(attempt).toMatchObject({
      status: 'ok',
      raw: { protocol: request.protocol, output: 'ok:cli-fixture' },
    });
    expect(attempt.diagnostics.stderrExcerpt).toContain('fixture stderr noise 50');
  });

  it.each(['with-trace', 'malformed-trace'])(
    'passes canonical %s output through without trace validation',
    async (behavior) => {
      const attempt = await invokeCliAgent(
        createCanonicalTarget(behavior),
        request,
        createOptions(),
      );

      expect(attempt.status).toBe('ok');
      if (attempt.status === 'ok') {
        expect(attempt.raw).toMatchObject({ trace: { schema: 'attest.trace/v1alpha1' } });
      }
    },
  );

  it('reports the canonical non-zero exit code before parsing its valid envelope', async () => {
    const attempt = requireInvocationError(
      await invokeCliAgent(createCanonicalTarget('nonzero-exit'), request, createOptions()),
    );

    expect(attempt.error.code).toBe('nonzero_exit');
    expect(attempt.diagnostics.exitCode).toBe(3);
    expect(attempt.rawExcerpt?.text).toContain(request.protocol);
  });

  it('classifies a valid envelope followed by exit 23 as nonzero_exit', async () => {
    const attempt = requireInvocationError(
      await invokeCliAgent(
        createPrivateFixtureTarget('envelope-then-exit-23-agent.cjs'),
        request,
        createOptions(),
      ),
    );

    expect(attempt.error.code).toBe('nonzero_exit');
    expect(attempt.error.code).not.toBe('invalid_envelope');
    expect(attempt.diagnostics.exitCode).toBe(23);
  });

  it('returns spawn_failed when the executable does not exist', async () => {
    const target: Extract<AgentTarget, { type: 'cli' }> = {
      type: 'cli',
      command: [join(PRIVATE_FIXTURE_DIRECTORY, 'missing-agent.cjs')],
    };
    const attempt = requireInvocationError(await invokeCliAgent(target, request, createOptions()));

    expect(attempt.error.code).toBe('spawn_failed');
  });

  it('decodes a 4096-byte stderr tail on a UTF-8 code-point boundary', async () => {
    const program = `process.stderr.write('€'.repeat(2000)); process.stdout.write(JSON.stringify({ protocol: '${request.protocol}', output: 'ok' }));`;
    const attempt = await invokeCliAgent(createInlineTarget(program), request, createOptions());
    const stderrExcerpt = attempt.diagnostics.stderrExcerpt ?? '';

    expect(attempt.status).toBe('ok');
    expect(stderrExcerpt).not.toContain('\uFFFD');
    expect(Buffer.byteLength(stderrExcerpt)).toBeLessThanOrEqual(4096);
  });

  it('ships the canonical and private hostile fixtures', async () => {
    await Promise.all([
      access(CANONICAL_AGENT_PATH),
      access(join(PRIVATE_FIXTURE_DIRECTORY, 'session-escape-agent.cjs')),
      access(join(PRIVATE_FIXTURE_DIRECTORY, 'ignore-sigterm-agent.cjs')),
      access(join(PRIVATE_FIXTURE_DIRECTORY, 'envelope-then-exit-23-agent.cjs')),
      access(join(PRIVATE_FIXTURE_DIRECTORY, 'sigterm-forks-setsid-agent.cjs')),
      access(join(PRIVATE_FIXTURE_DIRECTORY, 'normal-exit-orphan-agent.cjs')),
      access(join(PRIVATE_FIXTURE_DIRECTORY, 'marker-probe-agent.cjs')),
    ]);
  });
});
