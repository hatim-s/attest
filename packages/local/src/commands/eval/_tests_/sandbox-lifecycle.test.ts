import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  evalRunSchema,
  parseAgentResponse,
  type AgentRequest,
  type EvalRun,
} from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import { AgentInvocationError, type InvocationResult } from '@attest/executor';
import { EvalCaseStageError, type ResolvedEvalCase } from '@attest/runtime';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createEvalCaseRunner } from '../eval-agent-runner.js';
import type { ResolvedEvalCaseInput } from '../eval-resolver.js';

const sandboxInvoke = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<InvocationResult>>());
vi.mock('@attest/executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@attest/executor')>()),
  invokeVercelSandboxAgent: sandboxInvoke,
}));

const directories: string[] = [];
const cache: CacheStore = { get: () => Promise.resolve(undefined), put: () => Promise.resolve() };

/** Uses a copy of the canonical contracts run fixture while setting only the lifecycle configuration under test. */
const createRun = async (execution: EvalRun['effective_command']['resolved']['execution']) => {
  const fixture = await readFile(new URL('./fixtures/eval-run.json', import.meta.url), 'utf8');
  const run = evalRunSchema.parse(JSON.parse(fixture));
  if (execution === undefined) delete run.effective_command.resolved.execution;
  else run.effective_command.resolved.execution = execution;
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
const publishArtifact = async (...args: unknown[]): Promise<InvocationResult> => {
  const request = args[2] as AgentRequest;
  const { artifactRoot } = args[3] as { artifactRoot: string };
  await mkdir(artifactRoot, { recursive: true });
  expect(await readdir(artifactRoot)).toEqual([]);
  await writeFile(join(artifactRoot, 'X'), request.case_id);
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
};

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
    const runner = createEvalCaseRunner(root, cache, run);

    const result = await runner.executeCase(
      run.run_id,
      createCase(0),
      new AbortController().signal,
      { workerIndex: 0 },
    );
    const stages = (await readFile(join(root, 'stages.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, string>);
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
    await runner.cleanup?.(run.run_id);
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
      const runner = createEvalCaseRunner(root, cache, run);

      const failure = await runner
        .executeCase(run.run_id, createCase(0), new AbortController().signal, {
          workerIndex: 0,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(EvalCaseStageError);
      expect(failure).toMatchObject({
        stage,
        execution: { caseId: 'case-0', outcome: 'completed', attempts: [{ status: 'ok' }] },
        metrics: [],
      });
      expect((failure as EvalCaseStageError).cause).toMatchObject({
        message: `Eval ${stage} hook exited with code 7.`,
      });
      await runner.cleanup?.(run.run_id);
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
    sandboxInvoke.mockResolvedValue({ ...attempt, attempts: [attempt] });
    const runner = createEvalCaseRunner(root, cache, run);

    const failure = await runner
      .executeCase(run.run_id, createCase(0), new AbortController().signal, {
        workerIndex: 0,
      })
      .catch((error: unknown) => error);

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
    expect((failure as EvalCaseStageError).cause).toMatchObject({
      message: 'Eval after_agent hook exited with code 7.',
    });
    const cleanupFailure = await runner.cleanup?.(run.run_id).catch((error: unknown) => error);
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    if (!(cleanupFailure instanceof AggregateError)) throw new Error('Expected cleanup failure.');
    expect(
      (cleanupFailure.errors as unknown[]).map((error) =>
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
    const runner = createEvalCaseRunner(root, cache, run);
    const signal = new AbortController().signal;
    for (const index of [0, 1]) {
      const result = await runner.executeCase(run.run_id, createCase(index), signal, {
        workerIndex: 0,
      });
      expect(result.execution.outcome).toBe('completed');
      expect(result.execution.diagnostics.lifecycleError).toBeUndefined();
      expect(await readFile(join(root, `case-${index}.collected`), 'utf8')).toBe(`case-${index}`);
    }
    expect(await readdir(join(root, 'workers/0'))).toEqual([]);
    expect(sandboxInvoke).toHaveBeenCalledTimes(2);
    await runner.cleanup?.(run.run_id);
  });

  test('gives concurrent cases separate artifact directories without workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-sandbox-artifacts-'));
    directories.push(root);
    const run = await createRun(undefined);
    sandboxInvoke.mockImplementation(publishArtifact);
    const runner = createEvalCaseRunner(root, cache, run);
    const results = await Promise.all(
      [0, 1].map((index) =>
        runner.executeCase(run.run_id, createCase(index), new AbortController().signal, {
          workerIndex: index,
        }),
      ),
    );
    expect(results.map((result) => result.execution.outcome)).toEqual(['completed', 'completed']);
    for (const index of [0, 1]) {
      expect(await readFile(join(root, 'artifacts', run.run_id, String(index), 'X'), 'utf8')).toBe(
        `case-${index}`,
      );
    }
    await runner.cleanup?.(run.run_id);
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
    sandboxInvoke.mockResolvedValue({ ...attempt, attempts: [attempt] });
    const runner = createEvalCaseRunner(root, cache, run);
    const result = await runner.executeCase(
      run.run_id,
      createCase(0),
      new AbortController().signal,
      { workerIndex: 0 },
    );
    expect(result.execution.diagnostics.lifecycleError).toContain(
      'Vercel sandbox cleanup was not confirmed.',
    );
    expect(result.execution.diagnostics.lifecycleError).toContain(
      'Eval after_case hook exited with code 7.',
    );
    expect(result.execution.diagnostics.sandboxCleanupConfirmed).toBe(false);
    await expect(runner.cleanup?.(run.run_id)).rejects.toThrow('cleanup');
  });
});
