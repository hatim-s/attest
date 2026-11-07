import { SandboxAttemptCleanupError } from '@attest/executor';
import * as Cause from 'effect/Cause';
import * as Scope from 'effect/Scope';
import * as Exit from 'effect/Exit';
import { onTestFinished as finishNative } from 'vitest';
import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWithSchemaSync,
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  evalRunSchema,
  parseAgentResponse,
  type EvalRun,
} from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import { AgentInvocationError, invokeVercelSandboxAgent } from '@attest/executor';
import { EvalCaseStageError, type ResolvedEvalCase } from '@attest/runtime';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createEvalCaseRunner } from '../eval-agent-runner.js';
import type { ResolvedEvalCaseInput } from '../eval-resolver.js';

const sandboxInvoke = vi.fn<typeof invokeVercelSandboxAgent>();

const directories: string[] = [];

const cache: CacheStore = { get: () => Effect.succeed(undefined), put: () => Effect.void };

/** Uses a copy of the canonical contracts run fixture while setting only the lifecycle configuration under test. */
const createRun = async (execution: EvalRun['effective_command']['resolved']['execution']) => {
  const fixture = await readFile(new URL('./fixtures/eval-run.json', import.meta.url), 'utf8');
  let run = parseWithSchemaSync(evalRunSchema, JSON.parse(fixture));

  if (execution === undefined)
    run = {
      ...run,
      effective_command: {
        ...run.effective_command,
        resolved: { ...run.effective_command.resolved, execution: undefined },
      },
    };
  else
    run = {
      ...run,
      effective_command: {
        ...run.effective_command,
        resolved: { ...run.effective_command.resolved, execution: execution },
      },
    };

  return run;
};

const createCase = (index: number): ResolvedEvalCase<ResolvedEvalCaseInput> => {
  const caseId = `case-${index}`;
  const testCase = { id: caseId, input: { index } };

  return {
    configured_index: index,
    test_id: 'sandbox-test',
    case_id: caseId,
    source: { kind: 'direct' },
    payload: {
      agent: {
        schema: AGENT_RESOURCE_SCHEMA_ID,
        id: 'remote',
        name: 'Remote',
        transport: {
          kind: 'native_cli',
          lifecycle: 'per_case',
          argv: ['node', './agent.mjs'],
          sandbox: {
            kind: 'vercel',
            files: [],
            artifacts: [{ source: 'X', destination: 'X' }],
            artifact_directory: 'artifacts',
          },
        },
      },
      attempt_timeout_ms: 5000,
      case: testCase,
      case_id: caseId,
      concurrency: 1,
      configured_index: index,
      execution_id: `sandbox-test:${caseId}`,
      metrics: [],
      source: { kind: 'direct' },
      test: {
        schema: TEST_RESOURCE_SCHEMA_ID,
        id: 'sandbox-test',
        name: 'Sandbox test',
        agent_id: 'remote',
        cases: [testCase],
        datasets: [],
        metrics: [],
      },
      test_id: 'sandbox-test',
    },
  };
};

/** Simulates the adapter completing artifact publication and cleanup before returning. */
const publishArtifact: typeof invokeVercelSandboxAgent = Effect.fn(function* (
  _sandbox,
  _agent,
  request,
  { artifactRoot },
) {
  if (artifactRoot === undefined) throw new Error('Artifact root is required by this fixture.');
  yield* Effect.promise(() => mkdir(artifactRoot, { recursive: true }));
  expect(yield* Effect.promise(() => readdir(artifactRoot))).toEqual([]);
  yield* Effect.promise(() => writeFile(join(artifactRoot, 'X'), request.case_id));
  const raw = { protocol: AGENT_PROTOCOL, output: 'done' };

  const attempt = {
    status: 'ok' as const,
    raw,
    report: parseAgentResponse(raw),
    diagnostics: {},
    durationMs: 1,
    warnings: [],
  };

  return { ...attempt, attempts: [attempt] };
});

beforeEach(() => {
  sandboxInvoke.mockReset();
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('sandbox eval lifecycle integration', () => {
  test('runs post-agent lifecycle hooks in order with case and worker environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-sandbox-stage-hooks-'));
    directories.push(root);
    await writeFile(
      join(root, 'record-stage.mjs'),
      `
      import { appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      await appendFile(join(process.env.ATTEST_PROJECT_ROOT, 'stages.jsonl'), JSON.stringify({
        phase: process.argv[2],
        caseId: process.env.ATTEST_CASE_ID,
        testId: process.env.ATTEST_TEST_ID,
        workerIndex: process.env.ATTEST_WORKER_INDEX,
        workerDirectory: process.env.ATTEST_WORKER_DIRECTORY,
        outcome: process.env.ATTEST_CASE_OUTCOME,
      }) + '\\n');
    `,
    );

    const hook = (phase: string) => ({
      argv: [process.execPath, './record-stage.mjs', phase],
    });

    const run = await createRun({
      workers: { count: 1, directory: 'workers/{worker_index}' },
      hooks: {
        after_agent: hook('after_agent'),
        after_evaluation: hook('after_evaluation'),
        after_case: hook('after_case'),
      },
    });

    sandboxInvoke.mockImplementation(publishArtifact);

    const runner = await acquireNative(
      createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
    );

    const result = await runNative(
      runner.executeCase(run.run_id, createCase(0), new AbortController().signal, {
        workerIndex: 0,
      }),
    );

    const stages = (await readFile(join(root, 'stages.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) =>
        parseWithSchemaSync(Schema.Record(Schema.String, Schema.String), JSON.parse(line)),
      );

    const resolvedRoot = await realpath(root);

    expect(result.execution.outcome).toBe('completed');
    expect(stages.map(({ phase }) => phase)).toEqual([
      'after_agent',
      'after_evaluation',
      'after_case',
    ]);
    expect(stages).toEqual(
      stages.map((stage) => ({
        ...stage,
        caseId: 'case-0',
        testId: 'sandbox-test',
        workerIndex: '0',
        workerDirectory: join(resolvedRoot, 'workers/0'),
        outcome: 'completed',
      })),
    );
    await runNative(runner.cleanup?.(run.run_id) ?? Effect.void);
  });

  test.each(['after_agent', 'after_evaluation'] as const)(
    'retains agent evidence when the local %s hook fails',
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), `attest-sandbox-${stage}-`));
      directories.push(root);
      await writeFile(join(root, 'fail-hook.mjs'), 'process.exit(7);\n');

      const run = await createRun({
        hooks: { [stage]: { argv: [process.execPath, './fail-hook.mjs'] } },
      });

      sandboxInvoke.mockImplementation(publishArtifact);

      const runner = await acquireNative(
        createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
      );

      const failure = await runNative(
        runner.executeCase(run.run_id, createCase(0), new AbortController().signal, {
          workerIndex: 0,
        }),
      ).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(EvalCaseStageError);
      expect(failure).toMatchObject({
        stage,
        execution: { caseId: 'case-0', outcome: 'completed', attempts: [{ status: 'ok' }] },
        metrics: [],
      });

      if (!(failure instanceof EvalCaseStageError)) throw new Error('Expected case stage failure.');
      expect(failure.cause).toMatchObject({
        message: `Eval ${stage} hook exited with code 7.`,
      });
      await runNative(runner.cleanup?.(run.run_id) ?? Effect.void);
    },
  );

  test('latches sandbox cleanup uncertainty before a failing after_agent hook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-sandbox-after-agent-cleanup-'));
    directories.push(root);
    await writeFile(join(root, 'fail-hook.mjs'), 'process.exit(7);\n');

    const run = await createRun({
      hooks: { after_agent: { argv: [process.execPath, './fail-hook.mjs'] } },
    });

    const attempt = {
      status: 'invocation_error' as const,
      error: new AgentInvocationError('network', 'Sandbox stop failed.'),
      diagnostics: { sandboxCleanupConfirmed: false },
      durationMs: 1,
      warnings: [],
    };

    sandboxInvoke.mockReturnValue(Effect.succeed({ ...attempt, attempts: [attempt] }));

    const runner = await acquireNative(
      createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
    );

    const failure = await runNative(
      runner.executeCase(run.run_id, createCase(0), new AbortController().signal, {
        workerIndex: 0,
      }),
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(EvalCaseStageError);
    expect(failure).toMatchObject({
      stage: 'after_agent',
      execution: {
        caseId: 'case-0',
        diagnostics: {
          sandboxCleanupConfirmed: false,
          lifecycleError: 'Vercel sandbox cleanup was not confirmed.',
        },
      },
    });

    if (!(failure instanceof EvalCaseStageError)) throw new Error('Expected case stage failure.');
    expect(failure.cause).toMatchObject({
      message: 'Eval after_agent hook exited with code 7.',
    });

    const cleanupFailure = await runNative(runner.cleanup?.(run.run_id) ?? Effect.void).catch(
      (cause: unknown) => cause,
    );

    expect(cleanupFailure).toBeInstanceOf(AggregateError);

    if (!(cleanupFailure instanceof AggregateError)) throw new Error('Expected cleanup failure.');
    expect(
      Array.from<unknown>(cleanupFailure.errors).map((error) =>
        error instanceof Error ? error.message : '',
      ),
    ).toContain('One or more Vercel sandbox cleanups were not confirmed.');
  });

  test('publishes artifacts before after_case and reuses the emptied worker directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-sandbox-hooks-'));
    directories.push(root);
    await writeFile(
      join(root, 'collect.mjs'),
      `
      import { readFile, rm, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const content = await readFile('X', 'utf8');
      await writeFile(join(process.env.ATTEST_PROJECT_ROOT, process.env.ATTEST_CASE_ID + '.collected'), content);
      await rm('X');
    `,
    );

    const run = await createRun({
      workers: { count: 1, directory: 'workers/{worker_index}' },
      hooks: { after_case: { argv: [process.execPath, './collect.mjs'] } },
    });

    sandboxInvoke.mockImplementation(publishArtifact);

    const runner = await acquireNative(
      createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
    );

    const signal = new AbortController().signal;

    for (const index of [0, 1]) {
      const result = await runNative(
        runner.executeCase(run.run_id, createCase(index), signal, {
          workerIndex: 0,
        }),
      );

      expect(result.execution.outcome).toBe('completed');
      expect(result.execution.diagnostics.lifecycleError).toBeUndefined();
      expect(await readFile(join(root, `case-${index}.collected`), 'utf8')).toBe(`case-${index}`);
    }

    expect(await readdir(join(root, 'workers/0'))).toEqual([]);
    expect(sandboxInvoke).toHaveBeenCalledTimes(2);
    await runNative(runner.cleanup?.(run.run_id) ?? Effect.void);
  });

  test('gives concurrent cases separate artifact directories without workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-sandbox-artifacts-'));
    directories.push(root);
    const run = await createRun(undefined);
    sandboxInvoke.mockImplementation(publishArtifact);

    const runner = await acquireNative(
      createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
    );

    const results = await Promise.all(
      [0, 1].map((index) =>
        runNative(
          runner.executeCase(run.run_id, createCase(index), new AbortController().signal, {
            workerIndex: index,
          }),
        ),
      ),
    );

    expect(results.map((result) => result.execution.outcome)).toEqual(['completed', 'completed']);

    for (const index of [0, 1]) {
      expect(await readFile(join(root, 'artifacts', run.run_id, String(index), 'X'), 'utf8')).toBe(
        `case-${index}`,
      );
    }

    await runNative(runner.cleanup?.(run.run_id) ?? Effect.void);
  });
  test('blocks worker reuse and retains cleanup ownership when the VM stop fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-sandbox-cleanup-'));
    directories.push(root);
    await writeFile(join(root, 'fail-after-case.mjs'), 'process.exit(7);\n');

    const run = await createRun({
      workers: { count: 1, directory: 'workers/{worker_index}' },
      hooks: { after_case: { argv: [process.execPath, './fail-after-case.mjs'] } },
    });

    const attempt = {
      status: 'invocation_error' as const,
      error: new AgentInvocationError('network', 'Sandbox stop failed.'),
      diagnostics: { sandboxCleanupConfirmed: false },
      durationMs: 1,
      warnings: [],
    };

    sandboxInvoke.mockReturnValue(Effect.succeed({ ...attempt, attempts: [attempt] }));

    const runner = await acquireNative(
      createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
    );

    const result = await runNative(
      runner.executeCase(run.run_id, createCase(0), new AbortController().signal, {
        workerIndex: 0,
      }),
    );

    expect(result.execution.diagnostics.lifecycleError).toContain(
      'Vercel sandbox cleanup was not confirmed.',
    );
    expect(result.execution.diagnostics.lifecycleError).toContain(
      'Eval after_case hook exited with code 7.',
    );
    expect(result.execution.diagnostics.sandboxCleanupConfirmed).toBe(false);
    await expect(runNative(runner.cleanup?.(run.run_id) ?? Effect.void)).rejects.toThrow('cleanup');
  });
});

/** Executes native test operations without converting production owners back to Promises. */
const runNative = async <A, E extends Error>(operation: Effect.Effect<A, E>) =>
  valueFromExit(await Effect.runPromiseExit(operation));

/** Retains acquisition scope through each test's accepted work and explicit cleanup. */
const acquireNative = async <A, E extends Error>(operation: Effect.Effect<A, E, Scope.Scope>) => {
  const scope = await runNative(Scope.make());
  finishNative(() => runNative(Scope.close(scope, Exit.void)));

  return runNative(Scope.provide(operation, scope));
};

test('keeps a mixed after-agent Cause native and joins after-case cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-native-mixed-'));
  directories.push(root);
  // A .cjs hook works on both Node and Bun without changing project module mode.
  await writeFile(
    join(root, 'after.cjs'),
    "require('node:fs').writeFileSync('joined', 'yes');",
    'utf8',
  );

  const run = await createRun({
    hooks: { after_case: { argv: [process.execPath, './after.cjs'] } },
  });

  const raw = { protocol: AGENT_PROTOCOL, output: 'done' };

  const attempt = {
    status: 'ok' as const,
    raw,
    report: parseAgentResponse(raw),
    diagnostics: {},
    durationMs: 1,
    warnings: [],
  };

  sandboxInvoke.mockReturnValue(Effect.succeed({ ...attempt, attempts: [attempt] }));

  const runner = await acquireNative(
    createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
  );

  const defect = new Error('stage defect');
  const typed = new Error('typed stage error');
  const mixed = Cause.combine(Cause.fail(typed), Cause.die(defect));

  const exit = await Effect.runPromiseExit(
    runner.executeCase(run.run_id, createCase(0), new AbortController().signal, {
      workerIndex: 0,
      afterAgent: () => Effect.failCause(mixed),
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons).toHaveLength(2);
    expect(
      exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === typed),
    ).toBe(true);
    expect(
      exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect),
    ).toBe(true);
  }

  expect(await readFile(join(root, 'joined'), 'utf8')).toBe('yes');
  await runNative(runner.cleanup?.(run.run_id) ?? Effect.void);
});

test('projects private sandbox cleanup evidence without serializing the original secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-private-cleanup-'));
  directories.push(root);
  const run = await createRun(undefined);
  const raw = { protocol: AGENT_PROTOCOL, output: { token: 'private-cleanup-secret' } };

  const attempt = {
    status: 'ok' as const,
    raw,
    report: parseAgentResponse(raw),
    diagnostics: {},
    durationMs: 17,
    warnings: [],
  };

  const cleanupCause = Cause.die(new Error('cleanup defect'));

  const error = new SandboxAttemptCleanupError({
    attempt,
    cleanupCause,
  });

  sandboxInvoke.mockReturnValue(Effect.fail(error));

  const runner = await acquireNative(
    createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
  );

  const result = await runNative(
    runner.executeCase(run.run_id, createCase(0), new AbortController().signal, { workerIndex: 0 }),
  );

  expect(result.execution.outcome).toBe('invocation_error');
  expect(result.execution.diagnostics.sandboxCleanupConfirmed).toBe(false);
  expect(result.execution.attempts[0]?.durationMs).toBe(17);
  expect(JSON.stringify(result)).not.toContain('private-cleanup-secret');
  expect(
    Object.getOwnPropertyDescriptor(result.execution, 'localInvocationEvidence'),
  ).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(result, 'localInvocationEvidence')).toBeUndefined();
  const release = await Effect.runPromiseExit(runner.cleanup?.(run.run_id) ?? Effect.void);
  expect(Exit.isFailure(release)).toBe(true);

  if (Exit.isFailure(release)) expect(Cause.hasDies(release.cause)).toBe(true);
});

test('retains the earlier retry through private terminal cleanup projection and redaction without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-retry-cleanup-'));
  directories.push(root);
  const run = await createRun(undefined);
  const controller = new AbortController();
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  const defect = new Error('terminal listener cleanup');
  let releases = 0;
  Object.defineProperty(controller.signal, 'removeEventListener', {
    value: (...args: Parameters<typeof remove>) => {
      remove(...args);

      if (++releases === 2) throw defect;
    },
  });
  let dispatches = 0;
  const stop = vi.fn(() => Promise.resolve());
  sandboxInvoke.mockImplementation((sandbox, invocation, request, options) =>
    invokeVercelSandboxAgent(sandbox, invocation, request, {
      ...options,
      signal: controller.signal,
      credentialEnv: { VERCEL_OIDC_TOKEN: 'fixture-token' },
      sandboxFactory: () =>
        Promise.resolve({
          writeFiles: () => Promise.resolve(),
          readFile: () => Promise.resolve(null),
          stop,
          runCommand: (command) => {
            if (command.cmd !== 'mkdir') {
              dispatches++;
              command.stdout?.write(
                JSON.stringify(
                  dispatches === 1
                    ? { token: 'retry-secret' }
                    : { protocol: AGENT_PROTOCOL, output: { token: 'retry-secret' } },
                ),
              );
            }

            return Promise.resolve({ exitCode: 0 });
          },
        }),
    }),
  );
  const selected = createCase(0);
  selected.payload.agent = {
    ...selected.payload.agent,
    retry: { retries: 3, backoff: { kind: 'none' } },
  };

  if (
    selected.payload.agent.transport.kind !== 'native_cli' ||
    selected.payload.agent.transport.sandbox === undefined
  )
    throw new Error('Expected sandbox agent.');
  selected.payload.agent = {
    ...selected.payload.agent,
    transport: {
      ...selected.payload.agent.transport,
      sandbox: { ...selected.payload.agent.transport.sandbox, artifacts: [] },
    },
  };

  const runner = await acquireNative(
    createEvalCaseRunner(root, cache, run, { invokeSandbox: sandboxInvoke }),
  );

  const result = await runNative(
    runner.executeCase(run.run_id, selected, new AbortController().signal, { workerIndex: 0 }),
  );

  expect(result.execution.attempts).toHaveLength(2);
  expect(result.execution.attempts[0]).toMatchObject({
    status: 'invocation_error',
    error: { code: 'invalid_envelope' },
  });
  expect(result.execution.attempts[1]).toMatchObject({
    status: 'invocation_error',
    diagnostics: { sandboxCleanupConfirmed: false },
  });
  expect(JSON.stringify(result)).not.toContain('retry-secret');
  expect(dispatches).toBe(2);
  expect(stop).toHaveBeenCalledOnce();
  const release = await Effect.runPromiseExit(runner.cleanup?.(run.run_id) ?? Effect.void);
  expect(Exit.isFailure(release)).toBe(true);

  if (Exit.isFailure(release))
    expect(
      release.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect),
    ).toBe(true);
});
