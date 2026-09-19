import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import {
  AgentInvocationError,
  type InvocationResult,
  type ResolvedEvalCase,
} from '@attest/runtime';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createEvalCaseRunner } from '../eval-agent-runner.js';
import type { ResolvedEvalCaseInput } from '../eval-resolver.js';

const sandboxInvoke = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<InvocationResult>>());
vi.mock('@attest/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@attest/runtime')>()),
  invokeVercelSandboxAgent: sandboxInvoke,
}));

const directories: string[] = [];
const cache: CacheStore = { get: () => Promise.resolve(undefined), put: () => Promise.resolve() };

/** Uses the canonical run fixture while setting only the lifecycle configuration under test. */
const createRun = async (execution: EvalRun['effective_command']['resolved']['execution']) => {
  const fixture = await readFile(
    new URL(
      '../../../../../contracts/src/_tests_/fixtures/eval-run/eval-run.json',
      import.meta.url,
    ),
    'utf8',
  );
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
        worker_index: 0,
      });
      expect(result.execution.outcome).toBe('completed');
      expect(result.lifecycle_error).toBeUndefined();
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
          worker_index: index,
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
    const run = await createRun({ workers: { count: 1, directory: 'workers/{worker_index}' } });
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
      { worker_index: 0 },
    );
    expect(result.lifecycle_error).toBeDefined();
    expect(result.execution.diagnostics.sandboxCleanupConfirmed).toBe(false);
    await expect(runner.cleanup?.(run.run_id)).rejects.toThrow('cleanup');
  });
});
