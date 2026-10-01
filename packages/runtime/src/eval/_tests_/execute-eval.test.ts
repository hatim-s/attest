import { evalEventStreamSchema, evalRunSchema } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import { deferred } from '../../_tests_/support/deferred.js';
import { executeResolvedEvalPlan } from '../engine/execute-eval.js';
import type { EvalCaseRunner } from '../types.js';
import {
  BASELINE_RUN_ID,
  completedExecution,
  createClock,
  createPersistence,
  createPlan,
  errorMetric,
  failedExecution,
  failingMetric,
  passingMetric,
  RUN_ID,
  waitForAbort,
} from './support/eval-fixtures.js';

type Persistence = ReturnType<typeof createPersistence>;

describe('executeResolvedEvalPlan', () => {
  it.each([false, true])(
    'returns a failed result when the start event exceeds its cap, with finalization failure %s',
    async (finalizationFails) => {
      const plan = createPlan(['case-zero']);
      plan.run.snapshot.selection = {
        total_cases: 1,
        matched_cases: 1,
        selected_cases: 1,
        sample: { count: 1, seed: 'x'.repeat(20_000), algorithm: 'hash-rank-v1' },
      };
      expect(evalRunSchema.safeParse(plan.run).success).toBe(true);
      const persistence = createPersistence();
      if (finalizationFails) {
        persistence.finalizeRun.mockRejectedValue(new Error('row remains running'));
      }
      const beforeRun = vi.fn(() => Promise.resolve());
      const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>();

      const result = await executeResolvedEvalPlan(
        plan,
        { beforeRun, executeCase },
        persistence.adapter,
        { now: createClock() },
      );

      expect(result).toMatchObject({
        status: 'failed',
        exit_code: 4,
        cases: [],
        can_release_cancellation_ownership: !finalizationFails,
      });
      expect(persistence.finalizeRun).toHaveBeenCalledWith(RUN_ID, 'failed', result.summary);
      expect(beforeRun).not.toHaveBeenCalled();
      expect(executeCase).not.toHaveBeenCalled();
      expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
    },
  );

  it('rejects invalid global concurrency before persistence or case scheduling', async () => {
    const persistence = createPersistence();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>();

    const result = await executeResolvedEvalPlan(
      createPlan(['case-zero'], { concurrency: 0 }),
      { executeCase },
      persistence.adapter,
      { now: createClock() },
    );

    expect(result).toMatchObject({ status: 'failed', exit_code: 4, cases: [] });
    expect(persistence.createRun).not.toHaveBeenCalled();
    expect(executeCase).not.toHaveBeenCalled();
  });

  it('observes cancellation that arrives while run creation is in flight', async () => {
    const persistence = createPersistence();
    const creation = deferred<void>();
    persistence.createRun.mockReturnValueOnce(creation.promise);
    const controller = new AbortController();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>(waitForAbort);

    const pending = executeResolvedEvalPlan(
      createPlan(['case-zero']),
      { executeCase },
      persistence.adapter,
      { now: createClock(), signal: controller.signal },
    );
    await vi.waitFor(() => expect(persistence.createRun).toHaveBeenCalledOnce());
    controller.abort(new Error('cancel during create'));
    creation.resolve(undefined);

    expect((await pending).status).toBe('cancelled');
    expect(executeCase).not.toHaveBeenCalled();
  });

  it('propagates cancellation to active and queued work, drains it, and cleans up once', async () => {
    const controller = new AbortController();
    const observedSignals: AbortSignal[] = [];
    const cleanup = vi.fn(() => Promise.resolve());
    const runner: EvalCaseRunner<string> = {
      executeCase: (runId, resolvedCase, signal, context) => {
        observedSignals.push(signal);
        return waitForAbort(runId, resolvedCase, signal, context);
      },
      cleanup,
    };

    const execution = executeResolvedEvalPlan(
      createPlan(['case-zero', 'case-one', 'case-two']),
      runner,
      createPersistence().adapter,
      { signal: controller.signal, now: createClock() },
    );
    await vi.waitFor(() => expect(observedSignals).toHaveLength(2));
    controller.abort(new Error('user interrupted'));
    const result = await execution;

    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every(({ aborted }) => aborted)).toBe(true);
    expect(result).toMatchObject({ status: 'cancelled', exit_code: 130 });
    expect(result.cases).toHaveLength(3);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it.each([
    {
      failure: 'runner cleanup rejects',
      runner: { cleanup: () => Promise.reject(new Error('child still live')) },
      arrange: (): void => undefined,
    },
    {
      failure: 'after_run reports uncertain cleanup',
      runner: {
        afterRun: () =>
          Promise.reject(
            Object.assign(new Error('hook child may still be live'), { cleanupConfirmed: false }),
          ),
      },
      arrange: (): void => undefined,
    },
    {
      failure: 'finalization keeps failing',
      runner: {},
      arrange: (persistence: Persistence): void =>
        void persistence.finalizeRun.mockRejectedValue(new Error('row remains running')),
    },
  ])('fails and retains cancellation ownership when $failure', async (scenario) => {
    const controller = new AbortController();
    const persistence = createPersistence();
    scenario.arrange(persistence);
    const executeCase = vi.fn(waitForAbort);
    const runner: EvalCaseRunner<string> = { executeCase, ...scenario.runner };

    const execution = executeResolvedEvalPlan(
      createPlan(['case-zero']),
      runner,
      persistence.adapter,
      {
        signal: controller.signal,
        now: createClock(),
      },
    );
    await vi.waitFor(() => expect(executeCase).toHaveBeenCalledOnce());
    controller.abort(new Error('user interrupted'));
    const result = await execution;

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 4,
      can_release_cancellation_ownership: false,
    });
    expect(persistence.finalizeRun).toHaveBeenLastCalledWith(RUN_ID, 'failed', result.summary);
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('fails and retains cancellation ownership when any case record is not durable', async () => {
    const controller = new AbortController();
    const persistence = createPersistence();
    persistence.recordCase.mockRejectedValue(new Error('case row unavailable'));
    const executeCase = vi.fn(waitForAbort);

    const execution = executeResolvedEvalPlan(
      createPlan(['active', 'queued'], { concurrency: 1 }),
      { executeCase },
      persistence.adapter,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(executeCase).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    const result = await execution;

    expect(result).toMatchObject({ status: 'failed', can_release_cancellation_ownership: false });
    expect(result.cases).toHaveLength(2);
    expect(persistence.finalizeRun).toHaveBeenLastCalledWith(RUN_ID, 'failed', result.summary);
  });

  it('classifies a whole-run deadline as infrastructure even when runners return cancelled outcomes', async () => {
    const cleanup = vi.fn(() => Promise.resolve());

    const result = await executeResolvedEvalPlan(
      createPlan(['case-zero'], { timeoutMs: 1 }),
      { executeCase: waitForAbort, cleanup },
      createPersistence().adapter,
      { now: createClock() },
    );

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 4,
      final_result: {
        exit_code: 4,
        result: {
          ok: false,
          error: { code: 'run_failed', message: 'Eval run deadline exceeded.' },
        },
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps runner and invocation failures distinct from completed cases', async () => {
    const plan = createPlan(['runner-rejects', 'invocation-fails', 'passes'], { concurrency: 3 });
    const runner: EvalCaseRunner<string> = {
      executeCase: (_runId, resolvedCase) => {
        if (resolvedCase.case_id === 'runner-rejects') throw new Error('synchronous throw');
        return Promise.resolve(
          resolvedCase.case_id === 'invocation-fails'
            ? failedExecution(resolvedCase)
            : completedExecution(resolvedCase, [passingMetric()]),
        );
      },
    };

    const result = await executeResolvedEvalPlan(plan, runner, createPersistence().adapter, {
      now: createClock(),
    });

    expect(result).toMatchObject({ status: 'failed', exit_code: 4 });
    expect(result.summary).toEqual({
      total_cases: 3,
      passed_cases: 1,
      failed_cases: 0,
      error_cases: 2,
      metric_error_count: 0,
    });
    expect(result.cases.map(({ kind }) => kind).sort()).toEqual([
      'executed',
      'executed',
      'infrastructure_error',
    ]);
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('keeps runner failure details in case evidence and out of the public terminal result', async () => {
    const sensitiveMessage =
      'provider failed for https://alice:super-secret@example.test/api?token=top-secret';

    const result = await executeResolvedEvalPlan(
      createPlan(['case-zero']),
      { executeCase: () => Promise.reject(new Error(sensitiveMessage)) },
      createPersistence().adapter,
      { now: createClock() },
    );

    expect(result.cases).toMatchObject([
      { kind: 'infrastructure_error', error: { message: sensitiveMessage } },
    ]);
    expect(result.final_result).toMatchObject({
      exit_code: 4,
      result: {
        ok: false,
        error: {
          code: 'run_failed',
          message: 'Eval run encountered an invocation, metric, persistence, or artifact error.',
        },
      },
    });
    expect(JSON.stringify(result.final_result)).not.toContain('secret');
  });

  it.each([
    ['evaluated metric failure', failingMetric(), 'completed', 1, 1, 0],
    ['metric execution error', errorMetric(), 'failed', 4, 0, 1],
  ] as const)(
    'classifies %s without conflating failure and infrastructure error',
    async (_label, metric, status, exitCode, failedCases, errorCases) => {
      const result = await executeResolvedEvalPlan(
        createPlan(['case-zero']),
        {
          executeCase: (_runId, resolvedCase) =>
            Promise.resolve(completedExecution(resolvedCase, [metric])),
        },
        createPersistence().adapter,
        { now: createClock() },
      );

      expect(result).toMatchObject({ status, exit_code: exitCode });
      expect(result.summary).toMatchObject({
        failed_cases: failedCases,
        error_cases: errorCases,
        metric_error_count: errorCases,
      });
    },
  );

  it('returns the baseline diff and atomically publishes deterministic JUnit payload bytes', async () => {
    const diff = { summary: { regressions: 0 } };
    const diffRuns = vi.fn(() => Promise.resolve(diff));
    const writeJUnitAtomically = vi.fn(() => Promise.resolve());

    const result = await executeResolvedEvalPlan(
      createPlan(['case-zero'], { baseline: true, junit: true }),
      {
        executeCase: (_runId, resolvedCase) =>
          Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
      },
      createPersistence().adapter,
      { now: createClock(), baseline: { diffRuns }, artifacts: { writeJUnitAtomically } },
    );

    expect(result.exit_code).toBe(0);
    expect(result.baseline_diff).toEqual(diff);
    expect(result.junit?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.junit?.contents).toContain('<testsuite name="refund" tests="1"');
    expect(diffRuns).toHaveBeenCalledWith({
      baselineRunId: BASELINE_RUN_ID,
      candidateRunId: RUN_ID,
    });
    expect(writeJUnitAtomically).toHaveBeenCalledWith('artifacts/results.xml', result.junit);
  });

  it('classifies an atomic JUnit write failure as infrastructure and still emits one final result', async () => {
    const persistence = createPersistence();

    const result = await executeResolvedEvalPlan(
      createPlan(['case-zero'], { baseline: true, junit: true }),
      {
        executeCase: (_runId, resolvedCase) =>
          Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
      },
      persistence.adapter,
      {
        now: createClock(),
        baseline: { diffRuns: () => Promise.resolve({ stable: true }) },
        artifacts: { writeJUnitAtomically: () => Promise.reject(new Error('rename failed')) },
      },
    );

    expect(result).toMatchObject({ status: 'failed', exit_code: 4 });
    expect(result.events.filter(({ event }) => event === 'result')).toHaveLength(1);
    expect(result.events.at(-1)).toMatchObject({ event: 'result', data: { exit_code: 4 } });
    expect(persistence.finalizeRun).toHaveBeenCalledWith(RUN_ID, 'failed', result.summary);
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });
});
