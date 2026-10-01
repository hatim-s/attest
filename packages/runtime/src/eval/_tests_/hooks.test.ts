import type { CaseExecution } from '../types.js';
import type { StoredMetricEvaluation } from '@attest/core';
import { justBashIsolation, type CaseEnvironment } from '@attest/executor';
import { describe, expect, it, vi } from 'vitest';

import { executeResolvedEvalPlan } from '../engine/execute-eval.js';
import { EvalCaseStageError } from '../errors.js';
import { withEvalHooks } from '../hooks.js';
import type { EvalCaseRunner, ResolvedEvalCase } from '../types.js';
import {
  completedExecution,
  createPersistence,
  createPlan,
  passingMetric,
  RUN_ID,
} from './support/eval-fixtures.js';

type Stage = {
  resolvedCase: ResolvedEvalCase<string>;
  environment?: CaseEnvironment;
};

/** Runs agent work, then evaluation, awaiting the stage hooks in between as a real runner must. */
const stagedRunner = (
  invoke: (stage: Stage) => Promise<CaseExecution>,
  evaluate: (stage: Stage) => Promise<readonly StoredMetricEvaluation[]>,
): EvalCaseRunner<string> => ({
  executeCase: async (_runId, resolvedCase, _signal, context) => {
    const stage = { resolvedCase, environment: context.environment };
    const execution = await invoke(stage);
    await context.afterAgent?.(execution).catch((error: unknown) => {
      throw new EvalCaseStageError('after_agent', execution, [], error);
    });
    const metrics = await evaluate(stage);
    await context.afterEvaluation?.(execution, metrics).catch((error: unknown) => {
      throw new EvalCaseStageError('after_evaluation', execution, metrics, error);
    });
    return { execution, metrics };
  },
});

/** A fake environment whose finalization steps can be scripted. */
const fakeEnvironment = (overrides: Partial<CaseEnvironment> = {}): CaseEnvironment => ({
  kind: 'fake',
  beginFinalization: vi.fn(() => Promise.resolve()),
  exec: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  dispose: vi.fn(() => Promise.resolve()),
  ...overrides,
});

describe('eval hooks and case environments', () => {
  it('keeps the environment alive through all stages and isolates concurrent cases', async () => {
    const stages = new Map<string, string[]>();
    const runStages: string[] = [];
    const runner = stagedRunner(
      async ({ resolvedCase, environment }) => {
        stages.get(resolvedCase.case_id)?.push('invoke');
        expect(await environment?.readFile('case.txt')).toBe(resolvedCase.case_id);
        return completedExecution(resolvedCase).execution;
      },
      async ({ resolvedCase, environment }) => {
        stages.get(resolvedCase.case_id)?.push('evaluate');
        expect(await environment?.readFile('after-agent.txt')).toBe('ready');
        return [];
      },
    );

    const result = await executeResolvedEvalPlan(
      createPlan(['one', 'two']),
      runner,
      createPersistence().adapter,
      {
        isolation: justBashIsolation(),
        hooks: [
          {
            before_run: () => void runStages.push('before'),
            before_case: async ({ resolvedCase, environment }) => {
              stages.set(resolvedCase.case_id, ['before']);
              await environment?.writeFile('case.txt', resolvedCase.case_id);
            },
            after_agent: async ({ resolvedCase, environment }) => {
              stages.get(resolvedCase.case_id)?.push('after_agent');
              await environment?.writeFile('after-agent.txt', 'ready');
            },
            after_evaluation: ({ resolvedCase }) =>
              void stages.get(resolvedCase.case_id)?.push('after_evaluation'),
            after_case: async ({ resolvedCase, environment }) => {
              expect(await environment?.readFile('case.txt')).toBe(resolvedCase.case_id);
              stages.get(resolvedCase.case_id)?.push('after');
            },
            after_run: ({ status }) => void runStages.push(status),
          },
        ],
      },
    );

    expect(result.status).toBe('completed');
    expect([...stages.values()]).toEqual(
      Array.from({ length: 2 }, () => [
        'before',
        'invoke',
        'after_agent',
        'evaluate',
        'after_evaluation',
        'after',
      ]),
    );
    expect(runStages).toEqual(['before', 'completed']);
  });

  it('runs all final hooks and disposes the environment when setup throws', async () => {
    const dispose = vi.fn(() => Promise.resolve());
    const environment = fakeEnvironment({ dispose });
    const after = vi.fn();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>();

    const result = await executeResolvedEvalPlan(
      createPlan(['one']),
      { executeCase },
      createPersistence().adapter,
      {
        isolation: () => Promise.resolve(environment),
        hooks: [
          {
            before_case: () => {
              throw new Error('setup failed');
            },
            after_case: () => {
              throw new Error('teardown failed');
            },
          },
          { after_case: after },
        ],
      },
    );

    expect(result.status).toBe('failed');
    expect(executeCase).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('latches uncertain setup cleanup and aggregates the runner cleanup failure', async () => {
    const plan = createPlan(['one']);
    const setupFailure = Object.assign(new Error('setup child may be live'), {
      cleanupConfirmed: false,
    });
    const runnerCleanupFailure = new Error('runner cleanup failed');
    const wrapped = withEvalHooks<string>(
      plan.run,
      {
        beforeRun: () => Promise.reject(setupFailure),
        executeCase: (_runId, resolvedCase) => Promise.resolve(completedExecution(resolvedCase)),
        cleanup: () => Promise.reject(runnerCleanupFailure),
      },
      [],
    );

    await expect(wrapped.beforeRun?.(RUN_ID, new AbortController().signal)).rejects.toBe(
      setupFailure,
    );
    await expect(wrapped.cleanup?.(RUN_ID)).rejects.toMatchObject({
      errors: [setupFailure, runnerCleanupFailure],
      cleanupConfirmed: false,
    });
  });

  it.each([
    {
      disposal: 'fails',
      disposeResult: () => Promise.reject(new Error('environment disposal failed')),
      canRelease: false,
    },
    { disposal: 'succeeds', disposeResult: () => Promise.resolve(), canRelease: true },
  ])(
    'records every finalization failure on fresh evidence when disposal $disposal',
    async ({ disposeResult, canRelease }) => {
      const plan = createPlan(['one']);
      const finalization: string[] = [];
      const original = completedExecution(plan.cases[0]!, [passingMetric()]);
      const persistence = createPersistence();

      const result = await executeResolvedEvalPlan(
        plan,
        { executeCase: () => Promise.resolve(original) },
        persistence.adapter,
        {
          isolation: () =>
            Promise.resolve(
              fakeEnvironment({
                beginFinalization: () => {
                  finalization.push('begin');
                  return Promise.reject(new Error('finalization transition failed'));
                },
                dispose: () => {
                  finalization.push('dispose');
                  return disposeResult();
                },
              }),
            ),
          hooks: [
            {
              after_case: () => {
                finalization.push('after_case_one');
                throw new Error('first after_case failed');
              },
            },
            { after_case: () => void finalization.push('after_case_two') },
          ],
        },
      );

      expect(finalization).toEqual(['begin', 'after_case_one', 'after_case_two', 'dispose']);
      const record = result.cases[0];
      if (record?.kind !== 'executed') throw new Error('Expected executed evidence.');
      expect(record.execution).not.toBe(original.execution);
      expect(record.normalized.verdict).toBe('error');
      expect(record.execution.diagnostics.lifecycleError).toContain(
        'finalization transition failed',
      );
      expect(record.execution.diagnostics.lifecycleError).toContain('first after_case failed');
      expect(persistence.recordCase).toHaveBeenCalledWith(RUN_ID, record);
      expect(result).toMatchObject({
        status: 'failed',
        can_release_cancellation_ownership: canRelease,
      });
    },
  );

  it('truncates lifecycle diagnostics to the persisted limit', async () => {
    const plan = createPlan(['one']);
    const result = await executeResolvedEvalPlan(
      plan,
      { executeCase: (_runId, resolvedCase) => Promise.resolve(completedExecution(resolvedCase)) },
      createPersistence().adapter,
      { hooks: [{ after_case: () => Promise.reject(new Error(`long ${'x'.repeat(5000)}`)) }] },
    );

    const record = result.cases[0];
    if (record?.kind !== 'executed') throw new Error('Expected executed evidence.');
    expect(record.execution.diagnostics.lifecycleError).toHaveLength(4096);
    expect(record.execution.diagnostics.lifecycleError?.endsWith(' [truncated]')).toBe(true);
  });

  it.each([
    { stage: 'after_agent' as const, expectedMetrics: 0 },
    { stage: 'after_evaluation' as const, expectedMetrics: 1 },
  ])('preserves completed evidence when $stage fails', async ({ stage, expectedMetrics }) => {
    const evaluate = vi.fn(() => Promise.resolve([passingMetric()]));
    const persistence = createPersistence();
    const runner = stagedRunner(
      ({ resolvedCase }) => Promise.resolve(completedExecution(resolvedCase).execution),
      evaluate,
    );

    const result = await executeResolvedEvalPlan(createPlan(['one']), runner, persistence.adapter, {
      hooks: [
        {
          [stage]: () => {
            throw new Error(`${stage} failed`);
          },
        },
      ],
    });

    const record = result.cases[0];
    if (record?.kind !== 'executed') throw new Error('Expected executed evidence.');
    expect(result.status).toBe('failed');
    expect(record.metrics).toHaveLength(expectedMetrics);
    expect(record.execution.diagnostics.lifecycleError).toContain(`${stage} failed`);
    expect(evaluate).toHaveBeenCalledTimes(stage === 'after_agent' ? 0 : 1);
    expect(record.normalized.verdict).toBe('error');
  });
});
