import { evalEventStreamSchema } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import { deferred, type Deferred } from '../../_tests_/support/deferred.js';
import { executeResolvedEvalPlan } from '../engine/execute-eval.js';
import { executeCases } from '../engine/execute-cases.js';
import type { EvalCaseRunner, EvalCaseRunnerResult, ResolvedEvalPlan } from '../types.js';
import {
  completedExecution,
  createClock,
  createPersistence,
  createPlan,
  failingMetric,
  passingMetric,
} from './support/eval-fixtures.js';

/** A runner whose cases finish only when the test completes them, recording start order. */
const controlledRunner = (plan: ResolvedEvalPlan<string>) => {
  const pending = new Map<string, Deferred<EvalCaseRunnerResult>>();
  const starts: { caseId: string; workerIndex: number }[] = [];
  const runner: EvalCaseRunner<string> = {
    executeCase: (_runId, resolvedCase, _signal, context) => {
      starts.push({ caseId: resolvedCase.case_id, workerIndex: context.workerIndex });
      const completion = deferred<EvalCaseRunnerResult>();
      pending.set(resolvedCase.case_id, completion);
      return completion.promise;
    },
  };
  const complete = (caseId: string, metrics = [passingMetric()]): void => {
    const resolvedCase = plan.cases.find(({ case_id }) => case_id === caseId);
    if (resolvedCase === undefined) throw new Error(`Unknown case ${caseId}.`);
    pending.get(caseId)?.resolve(completedExecution(resolvedCase, metrics));
  };
  const startedIds = () => starts.map(({ caseId }) => caseId);
  return { runner, starts, startedIds, complete };
};

describe('case scheduling', () => {
  it('bounds concurrency while retaining observed completion order and configured indexes', async () => {
    const plan = createPlan(['case-zero', 'case-one', 'case-two']);
    const control = controlledRunner(plan);
    const persistence = createPersistence();

    const execution = executeResolvedEvalPlan(plan, control.runner, persistence.adapter, {
      now: createClock(),
    });
    await vi.waitFor(() => expect(control.startedIds()).toEqual(['case-zero', 'case-one']));
    control.complete('case-one');
    await vi.waitFor(() => expect(control.startedIds()).toHaveLength(3));
    control.complete('case-two');
    await vi.waitFor(() => expect(persistence.recordCase).toHaveBeenCalledTimes(2));
    control.complete('case-zero', [failingMetric()]);
    const result = await execution;

    const completions = result.events.filter((event) => event.event === 'case_completed');
    expect(completions.map(({ data }) => data.case_id)).toEqual([
      'case-one',
      'case-two',
      'case-zero',
    ]);
    expect(completions.map(({ data }) => data.configured_index)).toEqual([1, 2, 0]);
    expect(completions.map(({ data }) => data.completion_index)).toEqual([0, 1, 2]);
    expect(control.starts.map(({ workerIndex }) => workerIndex)).toEqual([0, 1, 1]);
    expect(result).toMatchObject({
      status: 'completed',
      exit_code: 1,
      summary: { total_cases: 3, passed_cases: 2, failed_cases: 1, error_cases: 0 },
    });
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('runs balanced contiguous batches concurrently and each worker batch sequentially', async () => {
    const plan = createPlan(
      Array.from({ length: 7 }, (_, index) => `case-${String(index)}`),
      { concurrency: 3, workers: 3 },
    );
    const control = controlledRunner(plan);

    const execution = executeResolvedEvalPlan(plan, control.runner, createPersistence().adapter, {
      now: createClock(),
    });
    await vi.waitFor(() => expect(control.startedIds()).toEqual(['case-0', 'case-3', 'case-5']));
    control.complete('case-3');
    await vi.waitFor(() =>
      expect(control.starts.at(-1)).toEqual({ caseId: 'case-4', workerIndex: 1 }),
    );
    control.complete('case-5');
    await vi.waitFor(() =>
      expect(control.starts.at(-1)).toEqual({ caseId: 'case-6', workerIndex: 2 }),
    );
    control.complete('case-4');
    control.complete('case-6');
    control.complete('case-0');
    await vi.waitFor(() =>
      expect(control.starts.at(-1)).toEqual({ caseId: 'case-1', workerIndex: 0 }),
    );
    control.complete('case-1');
    await vi.waitFor(() =>
      expect(control.starts.at(-1)).toEqual({ caseId: 'case-2', workerIndex: 0 }),
    );
    control.complete('case-2');

    expect(await execution).toMatchObject({ status: 'completed', exit_code: 0 });
  });

  it('records the rest of a worker batch as failed once one of its cases fails', async () => {
    const plan = createPlan(['a', 'b', 'c', 'd'], { concurrency: 2, workers: 2 });
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>((_runId, resolvedCase) =>
      resolvedCase.case_id === 'a'
        ? Promise.reject(new Error('worker directory corrupted'))
        : Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
    );

    const result = await executeResolvedEvalPlan(
      plan,
      { executeCase },
      createPersistence().adapter,
      {
        now: createClock(),
      },
    );

    expect(executeCase.mock.calls.map(([, resolvedCase]) => resolvedCase.case_id).sort()).toEqual([
      'a',
      'c',
      'd',
    ]);
    const skipped = result.cases.find(({ resolved_case }) => resolved_case.case_id === 'b');
    expect(skipped).toMatchObject({
      kind: 'infrastructure_error',
      error: { message: 'worker directory corrupted' },
    });
  });

  it('admits the earliest eligible test queue while another test is at its cap', async () => {
    const plan = createPlan(
      [
        { caseId: 'a-1', testId: 'a' },
        { caseId: 'a-2', testId: 'a' },
        { caseId: 'b-1', testId: 'b' },
        { caseId: 'c-1', testId: 'c' },
      ],
      { concurrency: 3, testConcurrency: 1 },
    );
    const control = controlledRunner(plan);
    const persistence = createPersistence();

    const execution = executeCases(
      plan.run,
      plan.cases,
      control.runner,
      persistence.adapter,
      new AbortController().signal,
      () => Promise.resolve(),
    );
    await vi.waitFor(() => expect(control.startedIds()).toEqual(['a-1', 'b-1', 'c-1']));
    control.complete('b-1');
    await vi.waitFor(() => expect(persistence.recordCase).toHaveBeenCalledOnce());
    expect(control.startedIds()).toEqual(['a-1', 'b-1', 'c-1']);
    control.complete('a-1');
    await vi.waitFor(() => expect(control.startedIds().at(-1)).toBe('a-2'));
    control.complete('c-1');
    control.complete('a-2');

    const result = await execution;
    expect(result.records).toHaveLength(4);
    expect(result.persistenceConfirmed).toBe(true);
  });

  it('drains and records every case after a completion event fails', async () => {
    const plan = createPlan(['one', 'two', 'three']);
    const persistence = createPersistence();

    const result = await executeCases(
      plan.run,
      plan.cases,
      { executeCase: (_runId, resolvedCase) => Promise.resolve(completedExecution(resolvedCase)) },
      persistence.adapter,
      new AbortController().signal,
      (event) => {
        if (event.event === 'case_completed') throw new Error('event is too large');
        return Promise.resolve();
      },
    );

    expect(result.records).toHaveLength(3);
    expect(result.infrastructureErrors).toEqual(Array(3).fill('event is too large'));
    expect(persistence.recordCase).toHaveBeenCalledTimes(3);
  });

  it('classifies rejection from settlement time and does not invoke queued work after abort', async () => {
    const plan = createPlan(['settled-before-abort', 'queued-at-abort'], { concurrency: 1 });
    const controller = new AbortController();
    const secondStart = deferred<void>();
    const releaseSecondStart = deferred<void>();
    const executeCase = vi
      .fn<EvalCaseRunner<string>['executeCase']>()
      .mockRejectedValue(new Error('failed before abort'));

    const execution = executeCases(
      plan.run,
      plan.cases,
      { executeCase },
      createPersistence().adapter,
      controller.signal,
      async (event) => {
        if (event.event === 'case_started' && event.data.case_id === 'queued-at-abort') {
          secondStart.resolve();
          await releaseSecondStart.promise;
        }
      },
    );
    await secondStart.promise;
    controller.abort(new Error('cancel remaining work'));
    releaseSecondStart.resolve();

    const result = await execution;
    expect(executeCase).toHaveBeenCalledOnce();
    expect(result.records.map(({ normalized }) => normalized.outcome)).toEqual([
      'invocation_error',
      'cancelled',
    ]);
  });
});
