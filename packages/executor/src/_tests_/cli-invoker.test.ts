import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import type { AgentRequest } from '@attest/contracts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { invokeAgent } from '../invoke.js';
import { invokeCliAgent } from '../cli-invoker.js';
import type { NativeAgentTarget } from '../types.js';
import type { InvocationAttempt, InvokeOptions } from '../types.js';

/** Executes the native CLI owner at this fixture test boundary. */
const runCliAgent = (...args: Parameters<typeof invokeCliAgent>) =>
  Effect.runPromise(invokeCliAgent(...args));

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const CANONICAL_AGENT_PATH = join(
  REPOSITORY_ROOT,
  'conformance/src/_tests_/fixtures/fake-agents/cli-agent.cjs',
);

const PRIVATE_FIXTURE_DIRECTORY = fileURLToPath(new URL('./fixtures/', import.meta.url));

const TEST_TIMEOUT_MS = 15_000;

const HEARTBEAT_SETTLE_MS = 700;

const FIXTURE_READINESS_TIMEOUT_MS = 30_000;

const request: AgentRequest = {
  protocol: 'attest.agent-invocation',
  run_id: '01J9ZK7Q2M5X8W4V3T2R1QPN0M',
  case_id: 'cli-fixture',
  input: { question: 'hello' },
};

const createCanonicalTarget = (behavior: string): Extract<NativeAgentTarget, { type: 'cli' }> => ({
  type: 'cli',
  command: [process.execPath, CANONICAL_AGENT_PATH, `--behavior=${behavior}`],
});

const createPrivateFixtureTarget = (
  fixtureName: string,
): Extract<NativeAgentTarget, { type: 'cli' }> => ({
  type: 'cli',
  command: [process.execPath, join(PRIVATE_FIXTURE_DIRECTORY, fixtureName)],
});

const createInlineTarget = (program: string): Extract<NativeAgentTarget, { type: 'cli' }> => ({
  type: 'cli',
  command: [process.execPath, '-e', program],
});

const createEnvironment = (values: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '',
  ...values,
});

const createOptions = (overrides: Partial<InvokeOptions> = {}): InvokeOptions => ({
  // Node process startup can exceed 2s when the whole suite spawns in parallel;
  // failure-classification tests override this with deliberately small values.
  timeoutMs: 8_000,
  outputCapBytes: 1024 * 1024,
  env: createEnvironment(),
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

const isMissingProcessError = (cause: unknown): cause is Error => {
  return cause instanceof Error && 'code' in cause && cause.code === 'ESRCH';
};

/** Polls kill(pid, 0) so process cleanup assertions tolerate asynchronous OS reaping. */
const waitForMissingProcessError = async (processId: number): Promise<Error> => {
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
    if (error instanceof Error) return error;
    throw error;
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

describe('invokeCliAgent', { timeout: TEST_TIMEOUT_MS }, () => {
  it('writes the request and returns canonical parsed output', async () => {
    const attempt = await runCliAgent(createCanonicalTarget('happy'), request, createOptions());

    expect(attempt.status).toBe('ok');

    if (attempt.status === 'ok') {
      expect(attempt.raw).toEqual({ protocol: request.protocol, output: 'ok:cli-fixture' });
      expect(attempt.diagnostics.exitCode).toBe(0);
    }

    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns an agent error envelope as unvalidated raw output', async () => {
    const program = `process.stdout.write(JSON.stringify({ protocol: '${request.protocol}', error: { message: 'failed', code: 'fixture_failure' } }));`;
    const attempt = await runCliAgent(createInlineTarget(program), request, createOptions());

    expect(attempt.status).toBe('ok');

    if (attempt.status === 'ok') {
      expect(attempt.raw).toMatchObject({ error: { code: 'fixture_failure' } });
    }
  });

  it('times out the canonical hanging agent within the grace allowance', async () => {
    const timeoutMs = 100;
    const startedAt = performance.now();

    const attempt = requireInvocationError(
      await runCliAgent(
        createCanonicalTarget('hang'),
        request,
        createOptions({ timeoutMs, terminationGraceMs: 500 }),
      ),
    );

    expect(attempt.error.code).toBe('timeout');
    expect(attempt.diagnostics.unreapedProcessIds).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(timeoutMs + 2_500);
    expect(attempt.durationMs).toBeGreaterThanOrEqual(timeoutMs);
  });

  it('kills a grandchild that escaped into a new session', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const attempt = requireInvocationError(
        await runCliAgent(
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
      expect(attempt.diagnostics.unreapedProcessIds).toBeUndefined();
      const processId = parseStderrProcessId(attempt.diagnostics.stderrExcerpt);
      await expectHeartbeatStopped(heartbeatFile);
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('sweeps a detached descendant created by a SIGTERM handler', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const attempt = requireInvocationError(
        await runCliAgent(
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
      expect(attempt.diagnostics.unreapedProcessIds).toBeUndefined();
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
        await runCliAgent(
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
      expect(attempt.diagnostics.unreapedProcessIds).toBeUndefined();
      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs + terminationGraceMs - 75);
      expect(elapsedMs).toBeLessThan(timeoutMs + terminationGraceMs + 2_000);
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('kills the canonical agent promptly when stdout exceeds the cap', async () => {
    const startedAt = performance.now();

    const attempt = requireInvocationError(
      await runCliAgent(
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
    expect(attempt.diagnostics.unreapedProcessIds).toBeUndefined();
    expect(attempt.rawExcerpt).toMatchObject({ truncated: true });
    expect(attempt.rawExcerpt?.text.length).toBeLessThanOrEqual(4096);
    expect(attempt.rawExcerpt?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  it('gives caller cancellation precedence when timeout also expires', async () => {
    const abortController = new AbortController();

    const invocation = runCliAgent(
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
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
    expect(attempt.diagnostics.unreapedProcessIds).toBeUndefined();
  });

  it.each(['malformed-json', 'partial-stdout'])(
    'returns invalid_envelope for canonical %s output',
    async (behavior) => {
      const attempt = requireInvocationError(
        await runCliAgent(createCanonicalTarget(behavior), request, createOptions()),
      );

      expect(attempt.error.code).toBe('invalid_envelope');
      expect(attempt.rawExcerpt?.text.length).toBeGreaterThan(0);
      expect(attempt.warnings).toEqual([]);
    },
  );

  it('assembles canonical slow-drip output across streaming chunks', async () => {
    const attempt = await runCliAgent(
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
    const attempt = await runCliAgent(
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

  it('reports the canonical non-zero exit code before parsing its valid envelope', async () => {
    const attempt = requireInvocationError(
      await runCliAgent(createCanonicalTarget('nonzero-exit'), request, createOptions()),
    );

    expect(attempt.error.code).toBe('nonzero_exit');
    expect(attempt.diagnostics.exitCode).toBe(3);
    expect(attempt.rawExcerpt?.text).toContain(request.protocol);
  });

  it('classifies a valid envelope followed by exit 23 as nonzero_exit', async () => {
    const attempt = requireInvocationError(
      await runCliAgent(
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
    const target: Extract<NativeAgentTarget, { type: 'cli' }> = {
      type: 'cli',
      command: [join(PRIVATE_FIXTURE_DIRECTORY, 'missing-agent.cjs')],
    };

    const attempt = requireInvocationError(await runCliAgent(target, request, createOptions()));

    expect(attempt.error.code).toBe('spawn_failed');
  });

  it('decodes a 4096-byte stderr tail on a UTF-8 code-point boundary', async () => {
    const program = `process.stderr.write('€'.repeat(2000)); process.stdout.write(JSON.stringify({ protocol: '${request.protocol}', output: 'ok' }));`;
    const attempt = await runCliAgent(createInlineTarget(program), request, createOptions());
    const stderrExcerpt = attempt.diagnostics.stderrExcerpt ?? '';

    expect(attempt.status).toBe('ok');
    expect(stderrExcerpt).not.toContain('\uFFFD');
    expect(Buffer.byteLength(stderrExcerpt)).toBeLessThanOrEqual(4096);
  });

  it('joins child cleanup on fiber interruption without interrupting a sibling attempt', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const victim = yield* Effect.forkChild(
            invokeCliAgent(
              createInlineTarget(
                `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.appendFileSync(process.env.ORPHAN_HEARTBEAT_FILE, 'PID ' + process.pid + ' '); setInterval(() => fs.appendFileSync(process.env.ORPHAN_HEARTBEAT_FILE, 'tick '), 30);`,
              ),
              request,
              createOptions({
                terminationGraceMs: 100,
                env: createEnvironment({ ORPHAN_HEARTBEAT_FILE: heartbeatFile }),
              }),
            ),
          );

          const sibling = yield* Effect.forkChild(
            invokeCliAgent(
              createInlineTarget(
                `setTimeout(() => process.stdout.write(JSON.stringify({ output: 'sibling' })), 500);`,
              ),
              request,
              createOptions(),
            ),
          );

          const contents = yield* Effect.tryPromise(() => readHeartbeat(heartbeatFile));
          yield* Fiber.interrupt(victim);

          return {
            contents,
            victim: yield* Fiber.await(victim),
            sibling: yield* Fiber.join(sibling),
          };
        }),
      );

      expect(Exit.isFailure(result.victim)).toBe(true);

      if (Exit.isFailure(result.victim))
        expect(Cause.hasInterrupts(result.victim.cause)).toBe(true);
      expect(result.sibling).toMatchObject({ status: 'ok', raw: { output: 'sibling' } });
      await expectHeartbeatStopped(heartbeatFile);
      expect(await waitForMissingProcessError(parseStderrProcessId(result.contents))).toMatchObject(
        { code: 'ESRCH' },
      );
    });
  });

  it('joins the first-output snapshot and sweeps an escaped descendant after normal root close', async () => {
    await withHeartbeatFile(async (heartbeatFile) => {
      const program = `
        const { spawn } = require('node:child_process');
        const code = "const fs = require('node:fs'); const file = process.argv[1]; fs.appendFileSync(file, 'PID ' + process.pid + ' '); setInterval(() => fs.appendFileSync(file, 'tick '), 30);";
        const child = spawn(process.execPath, ['-e', code, process.env.ORPHAN_HEARTBEAT_FILE], { detached: true, stdio: 'ignore' });
        child.unref();
        setTimeout(() => { process.stdout.write(JSON.stringify({ output: 'normal' })); setTimeout(() => process.exit(0), 250); }, 100);
      `;

      const attempt = await runCliAgent(
        createInlineTarget(program),
        request,
        createOptions({
          terminationGraceMs: 100,
          env: createEnvironment({ ORPHAN_HEARTBEAT_FILE: heartbeatFile }),
        }),
      );

      expect(attempt).toMatchObject({ status: 'ok', raw: { output: 'normal' } });
      expect(attempt.diagnostics.unreapedProcessIds).toBeUndefined();
      await expectHeartbeatStopped(heartbeatFile);
      const processId = parseHeartbeatProcessId(await readHeartbeat(heartbeatFile));
      expect(await waitForMissingProcessError(processId)).toMatchObject({ code: 'ESRCH' });
    });
  });

  it('fails directory setup through the closed infrastructure channel', async () => {
    const exit = await Effect.runPromiseExit(
      invokeCliAgent(
        createCanonicalTarget('happy'),
        request,
        createOptions({ workingDirectory: CANONICAL_AGENT_PATH }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(false);
      const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
      expect(failure?._tag).toBe('Fail');

      if (failure?._tag === 'Fail') {
        expect(failure.error._tag).toBe('CliInfrastructureError');

        if (failure.error._tag === 'CliInfrastructureError')
          expect(failure.error.operation).toBe('create_directory');
      }
    }
  });
});

it.each([
  { stdout: 'invalid JSON', status: 'invocation_error' },
  { stdout: '{"output":"done"}', status: 'ok' },
])(
  'retains $status attempt evidence and prohibits retry when descendant observations are unavailable',
  async ({ stdout, status }) => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-unavailable-ps-'));
    const pidFile = join(directory, 'owned-pids');
    await writeFile(join(directory, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    await writeFile(pidFile, '');

    const program = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    fs.appendFileSync(${JSON.stringify(pidFile)}, child.pid + '\\n');
    child.unref();
    setTimeout(() => process.stdout.write(${JSON.stringify(stdout)}), 150);
  `;

    try {
      vi.stubEnv('PATH', directory);

      const exit = await Effect.runPromiseExit(
        invokeAgent(createInlineTarget(program), request, {
          ...createOptions({
            workingDirectory: directory,
            terminationGraceMs: 0,
            env: { PATH: directory },
          }),
          retries: 1,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
        expect(failure).toMatchObject({
          error: {
            _tag: 'CliCleanupError',
            attempt:
              status === 'ok'
                ? { status, raw: { output: 'done' } }
                : { status, error: { code: 'invalid_envelope' } },
          },
        });
      }

      const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean).map(Number);
      expect(pids).toHaveLength(1);
      expect(() => process.kill(pids[0]!, 0)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();

      for (const value of (await readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean)) {
        try {
          process.kill(Number(value), 'SIGKILL');
        } catch {
          /* The owned fixture may already have exited. */
        }
      }

      await rm(directory, { recursive: true, force: true });
    }
  },
);
