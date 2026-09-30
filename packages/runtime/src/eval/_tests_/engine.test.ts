import type { EvalRun } from '@attest/contracts';
import { evalEventStreamSchema } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { StoredMetricEvaluation } from '@attest/core';
import { AgentInvocationError } from '@attest/executor';
import type { CaseExecution } from '@attest/executor';
import { createStagedCaseRunner } from '../staged-runner.js';
import { justBashIsolation } from '@attest/executor';

import { executeResolvedEvalPlan } from '../engine/index.js';
import { withEvalHooks } from '../hooks.js';
import type {
  EvalCaseRunner,
  EvalPersistenceAdapter,
  ResolvedEvalCase,
  ResolvedEvalPlan,
} from '../types.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BASELINE_RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const PROJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const PROJECT_HASH = 'a'.repeat(64);
const SNAPSHOT_HASH = 'f'.repeat(64);

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
};

/** Creates a manually settled promise for deterministic completion-order probes. */
const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

/** Provides a monotonic injected ISO clock so event snapshots never depend on wall time. */
const createClock = (): (() => string) => {
  let milliseconds = 0;
  return () => new Date(Date.UTC(2026, 7, 8, 10, 0, 0, milliseconds++)).toISOString();
};

/** Builds a contract-shaped immutable run and its opaque already-resolved cases. */
const createPlan = (
  caseIds: readonly string[],
  options: {
    baseline?: boolean;
    junit?: boolean;
    concurrency?: number;
    testConcurrency?: number;
    timeoutMs?: number;
    workers?: number;
  } = {},
): ResolvedEvalPlan<string> => {
  const selectedCases = caseIds.map((caseId, configuredIndex) => ({
    configured_index: configuredIndex,
    test_id: 'refund',
    case_id: caseId,
    source: { kind: 'direct' as const },
  }));
  const baselineRunId = options.baseline ? BASELINE_RUN_ID : undefined;
  const junitPath = options.junit ? 'artifacts/results.xml' : undefined;
  const concurrency = options.concurrency ?? 2;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const run: EvalRun = {
    schema: 'attest.eval-run',
    run_id: RUN_ID,
    created_at: '2026-08-08T10:00:00.000Z',
    snapshot_hash: SNAPSHOT_HASH,
    snapshot: {
      project_id: PROJECT_ID,
      project_hash: PROJECT_HASH,
      resource_hashes: { agents: [], tests: [], datasets: [], metrics: [] },
      selected_test_ids: ['refund'],
      selected_cases: selectedCases,
    },
    effective_command: {
      command_path: ['eval', 'run'],
      argv: ['eval', 'run', 'refund'],
      request: {
        schema: 'attest.command-request',
        command: 'eval.run',
        test_ids: ['refund'],
        output: 'jsonl',
        ...(baselineRunId === undefined ? {} : { baseline_run_id: baselineRunId }),
        ...(junitPath === undefined ? {} : { junit_path: junitPath }),
      },
      resolved: {
        concurrency,
        timeout_ms: timeoutMs,
        output: 'jsonl',
        watch: false,
        ...(options.workers === undefined
          ? {}
          : {
              execution: {
                workers: {
                  count: options.workers,
                  directory: '.attest/runs/{run_id}/workers/{worker_index}',
                },
              },
            }),
        ...(baselineRunId === undefined ? {} : { baseline_run_id: baselineRunId }),
        ...(junitPath === undefined ? {} : { junit_path: junitPath }),
      },
    },
  };
  return {
    run,
    cases: selectedCases.map((selectedCase) => ({
      ...selectedCase,
      ...(options.testConcurrency === undefined
        ? {}
        : { test_concurrency: options.testConcurrency }),
      payload: selectedCase.case_id,
    })),
  };
};

/** Produces a normalized successful runner execution with caller-selected metric evidence. */
const completedExecution = (
  resolvedCase: ResolvedEvalCase<string>,
  metrics: readonly StoredMetricEvaluation[],
): { execution: CaseExecution; metrics: readonly StoredMetricEvaluation[] } => ({
  execution: {
    caseId: resolvedCase.case_id,
    suiteName: resolvedCase.test_id,
    request: {
      protocol: 'attest.agent-invocation',
      run_id: RUN_ID,
      case_id: resolvedCase.case_id,
      input: { prompt: resolvedCase.payload },
    },
    caseDefinition: { id: resolvedCase.case_id, input: { prompt: resolvedCase.payload } },
    expectedMetrics: metrics.map(({ metricName }) => metricName),
    attempts: [
      {
        status: 'ok',
        raw: { protocol: 'attest.agent-invocation', output: resolvedCase.payload },
        diagnostics: {},
        durationMs: 5,
        warnings: [],
      },
    ],
    diagnostics: {},
    warnings: [],
    startedAt: '2026-08-08T10:00:00.000Z',
    durationMs: 10,
    outcome: 'completed',
    response: { protocol: 'attest.agent-invocation', output: resolvedCase.payload },
  },
  metrics,
});

/** Produces an invocation failure while retaining a real existing runner result shape. */
const failedExecution = (
  resolvedCase: ResolvedEvalCase<string>,
  outcome: 'invocation_error' | 'timeout' | 'cancelled' = 'invocation_error',
): { execution: CaseExecution; metrics: readonly StoredMetricEvaluation[] } => {
  const code =
    outcome === 'timeout' ? 'timeout' : outcome === 'cancelled' ? 'cancelled' : 'network';
  const invocationError = new AgentInvocationError(code, `${resolvedCase.case_id} ${outcome}`);
  return {
    execution: {
      caseId: resolvedCase.case_id,
      suiteName: resolvedCase.test_id,
      request: {
        protocol: 'attest.agent-invocation',
        run_id: RUN_ID,
        case_id: resolvedCase.case_id,
        input: { prompt: resolvedCase.payload },
      },
      caseDefinition: { id: resolvedCase.case_id, input: { prompt: resolvedCase.payload } },
      expectedMetrics: [],
      attempts: [
        {
          status: 'invocation_error',
          error: invocationError,
          diagnostics: {},
          durationMs: 5,
          warnings: [],
        },
      ],
      diagnostics: {},
      warnings: [],
      startedAt: '2026-08-08T10:00:00.000Z',
      durationMs: 10,
      outcome,
      invocationError,
    },
    metrics: [],
  };
};

const passingMetric = (name = 'correct'): StoredMetricEvaluation => ({
  metricName: name,
  kind: 'assertion',
  status: 'evaluated',
  score: 1,
  pass: true,
  durationMs: 0,
});

const failingMetric = (name = 'correct'): StoredMetricEvaluation => ({
  metricName: name,
  kind: 'assertion',
  status: 'evaluated',
  score: 0,
  pass: false,
  rationale: 'expected mismatch',
  durationMs: 0,
});

const errorMetric = (name = 'correct'): StoredMetricEvaluation => ({
  metricName: name,
  kind: 'assertion',
  status: 'error',
  error: { kind: 'internal_error', message: 'metric adapter failed' },
  durationMs: 1,
});

/** Captures persistence calls without binding the engine tests to SQLite. */
const createPersistence = () => {
  const createRun = vi
    .fn<EvalPersistenceAdapter<string>['createRun']>()
    .mockResolvedValue(undefined);
  const recordCase = vi
    .fn<EvalPersistenceAdapter<string>['recordCase']>()
    .mockResolvedValue(undefined);
  const finalizeRun = vi
    .fn<EvalPersistenceAdapter<string>['finalizeRun']>()
    .mockResolvedValue(undefined);
  const adapter: EvalPersistenceAdapter<string> = { createRun, recordCase, finalizeRun };
  return { adapter, createRun, recordCase, finalizeRun };
};

describe('executeResolvedEvalPlan', () => {
  it('rejects invalid global concurrency before persistence or case scheduling', async () => {
    const plan = createPlan(['case-zero'], { concurrency: 0 });
    const persistence = createPersistence();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>();

    const result = await executeResolvedEvalPlan(plan, { executeCase }, persistence.adapter, {
      now: createClock(),
    });

    expect(result).toMatchObject({ status: 'failed', exit_code: 4, cases: [] });
    expect(persistence.createRun).not.toHaveBeenCalled();
    expect(executeCase).not.toHaveBeenCalled();
  });

  it('observes cancellation that arrives while run creation is in flight', async () => {
    const plan = createPlan(['case-zero']);
    const persistence = createPersistence();
    const creation = deferred<void>();
    persistence.createRun.mockReturnValueOnce(creation.promise);
    const controller = new AbortController();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>(
      (_runId, resolvedCase, signal) =>
        Promise.resolve(
          signal.aborted
            ? failedExecution(resolvedCase, 'cancelled')
            : completedExecution(resolvedCase, [passingMetric()]),
        ),
    );

    const pending = executeResolvedEvalPlan(plan, { executeCase }, persistence.adapter, {
      now: createClock(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(persistence.createRun).toHaveBeenCalledOnce());
    controller.abort(new Error('cancel during create'));
    creation.resolve(undefined);
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(executeCase).not.toHaveBeenCalled();
  });

  it('bounds concurrency while retaining actual completion order and configured indexes', async () => {
    const plan = createPlan(['case-zero', 'case-one', 'case-two']);
    const pending = new Map<string, Deferred<ReturnType<typeof completedExecution>>>();
    const starts: string[] = [];
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>(
      async (_runId, resolvedCase) => {
        starts.push(resolvedCase.case_id);
        const completion = deferred<ReturnType<typeof completedExecution>>();
        pending.set(resolvedCase.case_id, completion);
        return completion.promise;
      },
    );
    const cleanup = vi
      .fn<NonNullable<EvalCaseRunner<string>['cleanup']>>()
      .mockResolvedValue(undefined);
    const runner: EvalCaseRunner<string> = { executeCase, cleanup };
    const persistence = createPersistence();

    const execution = executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
    });
    await vi.waitFor(() => expect(starts).toEqual(['case-zero', 'case-one']));
    pending.get('case-one')!.resolve(completedExecution(plan.cases[1]!, [passingMetric()]));
    await vi.waitFor(() => expect(starts).toEqual(['case-zero', 'case-one', 'case-two']));
    pending.get('case-two')!.resolve(completedExecution(plan.cases[2]!, [passingMetric()]));
    pending.get('case-zero')!.resolve(completedExecution(plan.cases[0]!, [failingMetric()]));

    const result = await execution;
    const completions = result.events.filter((event) => event.event === 'case_completed');
    expect(completions.map(({ data }) => data.case_id)).toEqual([
      'case-one',
      'case-two',
      'case-zero',
    ]);
    expect(completions.map(({ data }) => data.configured_index)).toEqual([1, 2, 0]);
    expect(completions.map(({ data }) => data.completion_index)).toEqual([0, 1, 2]);
    expect(result).toMatchObject({
      status: 'completed',
      exit_code: 1,
      summary: {
        total_cases: 3,
        passed_cases: 2,
        failed_cases: 1,
        error_cases: 0,
        metric_error_count: 0,
      },
    });
    expect(result.events.filter(({ event }) => event === 'result')).toHaveLength(1);
    expect(result.events.at(-1)?.event).toBe('result');
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
    expect(Object.isFrozen(result.run)).toBe(true);
    expect(Object.isFrozen(result.run.snapshot)).toBe(true);
    expect(persistence.recordCase).toHaveBeenCalledTimes(3);
    expect(executeCase.mock.calls.map(([, , , context]) => context.worker_index)).toEqual([
      0, 1, 1,
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('runs balanced contiguous batches concurrently and each worker batch sequentially', async () => {
    const caseIds = Array.from({ length: 7 }, (_, index) => `case-${String(index)}`);
    const plan = createPlan(caseIds, { concurrency: 3, workers: 3 });
    const pending = new Map<string, Deferred<ReturnType<typeof completedExecution>>>();
    const starts: { caseId: string; workerIndex: number }[] = [];
    const runner: EvalCaseRunner<string> = {
      executeCase: async (_runId, resolvedCase, _signal, context) => {
        starts.push({ caseId: resolvedCase.case_id, workerIndex: context.worker_index });
        const completion = deferred<ReturnType<typeof completedExecution>>();
        pending.set(resolvedCase.case_id, completion);
        return completion.promise;
      },
    };
    const persistence = createPersistence();
    const execution = executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
    });
    const complete = (configuredIndex: number): void => {
      const resolvedCase = plan.cases[configuredIndex]!;
      pending
        .get(resolvedCase.case_id)!
        .resolve(completedExecution(resolvedCase, [passingMetric()]));
    };

    await vi.waitFor(() =>
      expect(starts).toEqual([
        { caseId: 'case-0', workerIndex: 0 },
        { caseId: 'case-3', workerIndex: 1 },
        { caseId: 'case-5', workerIndex: 2 },
      ]),
    );
    complete(3);
    await vi.waitFor(() => expect(starts.at(-1)).toEqual({ caseId: 'case-4', workerIndex: 1 }));
    expect(starts.some(({ caseId }) => caseId === 'case-1')).toBe(false);
    complete(5);
    await vi.waitFor(() => expect(starts.at(-1)).toEqual({ caseId: 'case-6', workerIndex: 2 }));
    complete(4);
    complete(6);
    complete(0);
    await vi.waitFor(() => expect(starts.at(-1)).toEqual({ caseId: 'case-1', workerIndex: 0 }));
    complete(1);
    await vi.waitFor(() => expect(starts.at(-1)).toEqual({ caseId: 'case-2', workerIndex: 0 }));
    complete(2);

    const result = await execution;
    expect(starts).toEqual([
      { caseId: 'case-0', workerIndex: 0 },
      { caseId: 'case-3', workerIndex: 1 },
      { caseId: 'case-5', workerIndex: 2 },
      { caseId: 'case-4', workerIndex: 1 },
      { caseId: 'case-6', workerIndex: 2 },
      { caseId: 'case-1', workerIndex: 0 },
      { caseId: 'case-2', workerIndex: 0 },
    ]);
    expect(result).toMatchObject({ status: 'completed', exit_code: 0 });
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('enforces the resolved per-test concurrency cap inside the global pool', async () => {
    const plan = createPlan(['case-zero', 'case-one', 'case-two'], {
      concurrency: 3,
      testConcurrency: 1,
    });
    const pending = new Map<string, Deferred<ReturnType<typeof completedExecution>>>();
    const starts: string[] = [];
    const runner: EvalCaseRunner<string> = {
      executeCase: async (_runId, resolvedCase) => {
        starts.push(resolvedCase.case_id);
        const completion = deferred<ReturnType<typeof completedExecution>>();
        pending.set(resolvedCase.case_id, completion);
        return completion.promise;
      },
    };
    const persistence = createPersistence();

    const execution = executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
    });
    await vi.waitFor(() => expect(starts).toEqual(['case-zero']));
    pending.get('case-zero')!.resolve(completedExecution(plan.cases[0]!, [passingMetric()]));
    await vi.waitFor(() => expect(starts).toEqual(['case-zero', 'case-one']));
    pending.get('case-one')!.resolve(completedExecution(plan.cases[1]!, [passingMetric()]));
    await vi.waitFor(() => expect(starts).toEqual(['case-zero', 'case-one', 'case-two']));
    pending.get('case-two')!.resolve(completedExecution(plan.cases[2]!, [passingMetric()]));

    const result = await execution;
    expect(result).toMatchObject({ status: 'completed', exit_code: 0 });
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('propagates cancellation to active and queued work, drains it, and cleans up once', async () => {
    const plan = createPlan(['case-zero', 'case-one', 'case-two'], { concurrency: 2 });
    const controller = new AbortController();
    const observedSignals: AbortSignal[] = [];
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>(
      async (_runId, resolvedCase, signal) => {
        observedSignals.push(signal);
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return failedExecution(resolvedCase, 'cancelled');
      },
    );
    const cleanup = vi
      .fn<NonNullable<EvalCaseRunner<string>['cleanup']>>()
      .mockResolvedValue(undefined);
    const runner: EvalCaseRunner<string> = { executeCase, cleanup };

    const persistence = createPersistence();
    const execution = executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      signal: controller.signal,
      now: createClock(),
    });
    await vi.waitFor(() => expect(observedSignals).toHaveLength(2));
    controller.abort(new Error('user interrupted'));
    const result = await execution;

    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every(({ aborted }) => aborted)).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.exit_code).toBe(130);
    expect(result.cases).toHaveLength(3);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('reports cancellation cleanup failure as infrastructure and retains ownership', async () => {
    const plan = createPlan(['case-zero']);
    const controller = new AbortController();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>(
      async (_runId, resolvedCase, signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return failedExecution(resolvedCase, 'cancelled');
      },
    );
    const runner: EvalCaseRunner<string> = {
      executeCase,
      cleanup: () => Promise.reject(new Error('child still live')),
    };
    const persistence = createPersistence();
    const execution = executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      signal: controller.signal,
      now: createClock(),
    });
    await vi.waitFor(() => expect(executeCase).toHaveBeenCalledOnce());
    controller.abort(new Error('user interrupted'));

    const result = await execution;
    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 4,
      can_release_cancellation_ownership: false,
    });
    expect(persistence.finalizeRun).toHaveBeenCalledWith(RUN_ID, 'failed', result.summary);
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('retains ownership when after_run reports uncertain hook cleanup', async () => {
    const plan = createPlan(['case-zero']);
    const cleanupError = Object.assign(new Error('hook child may still be live'), {
      cleanupConfirmed: false,
    });
    const runner: EvalCaseRunner<string> = {
      executeCase: (_runId, resolvedCase) =>
        Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
      afterRun: () => Promise.reject(cleanupError),
    };

    const result = await executeResolvedEvalPlan(plan, runner, createPersistence().adapter, {
      now: createClock(),
    });

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 4,
      can_release_cancellation_ownership: false,
    });
  });

  it('retries failed cancellation finalization as failed and retains ownership if it persists', async () => {
    const plan = createPlan(['case-zero']);
    const controller = new AbortController();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>(
      async (_runId, resolvedCase, signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return failedExecution(resolvedCase, 'cancelled');
      },
    );
    const persistence = createPersistence();
    persistence.finalizeRun.mockRejectedValue(new Error('row remains running'));
    const execution = executeResolvedEvalPlan(plan, { executeCase }, persistence.adapter, {
      signal: controller.signal,
      now: createClock(),
    });
    await vi.waitFor(() => expect(executeCase).toHaveBeenCalledOnce());
    controller.abort(new Error('user interrupted'));

    const result = await execution;
    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 4,
      can_release_cancellation_ownership: false,
    });
    expect(persistence.finalizeRun).toHaveBeenNthCalledWith(1, RUN_ID, 'cancelled', result.summary);
    expect(persistence.finalizeRun).toHaveBeenNthCalledWith(2, RUN_ID, 'failed', result.summary);
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('classifies a whole-run deadline as infrastructure even when runners return cancelled outcomes', async () => {
    const plan = createPlan(['case-zero'], { timeoutMs: 1 });
    const cleanup = vi
      .fn<NonNullable<EvalCaseRunner<string>['cleanup']>>()
      .mockResolvedValue(undefined);
    const runner: EvalCaseRunner<string> = {
      executeCase: async (_runId, resolvedCase, signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return failedExecution(resolvedCase, 'cancelled');
      },
      cleanup,
    };

    const persistence = createPersistence();
    const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
    });

    expect(result.status).toBe('failed');
    expect(result.exit_code).toBe(4);
    expect(result.final_result).toMatchObject({
      exit_code: 4,
      result: { ok: false, error: { code: 'run_failed', retryable: true } },
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps partial runner and invocation infrastructure failures distinct from completed cases', async () => {
    const plan = createPlan(['runner-rejects', 'invocation-fails', 'passes'], { concurrency: 3 });
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>((_runId, resolvedCase) => {
      if (resolvedCase.case_id === 'runner-rejects') {
        return Promise.reject(new Error('adapter exploded'));
      }
      return Promise.resolve(
        resolvedCase.case_id === 'invocation-fails'
          ? failedExecution(resolvedCase)
          : completedExecution(resolvedCase, [passingMetric()]),
      );
    });
    const runner: EvalCaseRunner<string> = { executeCase };

    const persistence = createPersistence();
    const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
    });

    expect(result.status).toBe('failed');
    expect(result.exit_code).toBe(4);
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
    const plan = createPlan(['case-zero']);
    const runner: EvalCaseRunner<string> = {
      executeCase: () => Promise.reject(new Error(sensitiveMessage)),
    };

    const result = await executeResolvedEvalPlan(plan, runner, createPersistence().adapter, {
      now: createClock(),
    });

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
    expect(JSON.stringify(result.final_result)).not.toContain('super-secret');
    expect(JSON.stringify(result.final_result)).not.toContain('top-secret');
  });

  it.each([
    ['evaluated metric failure', failingMetric(), 'completed', 1, 1, 0],
    ['metric execution error', errorMetric(), 'failed', 4, 0, 1],
  ] as const)(
    'classifies %s without conflating failure and infrastructure error',
    async (_label, metric, status, exitCode, failedCases, errorCases) => {
      const plan = createPlan(['case-zero']);
      const runner: EvalCaseRunner<string> = {
        executeCase: (_runId, resolvedCase) =>
          Promise.resolve(completedExecution(resolvedCase, [metric])),
      };
      const persistence = createPersistence();
      const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
        now: createClock(),
      });

      expect(result.status).toBe(status);
      expect(result.exit_code).toBe(exitCode);
      expect(result.summary.failed_cases).toBe(failedCases);
      expect(result.summary.error_cases).toBe(errorCases);
      expect(result.summary.metric_error_count).toBe(errorCases);
    },
  );

  it('fails before persistence or execution when the deterministic event cap cannot fit the plan', async () => {
    const plan = createPlan(['case-zero', 'case-one']);
    const persistence = createPersistence();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>((_runId, resolvedCase) =>
      Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
    );
    const runner: EvalCaseRunner<string> = { executeCase };
    const onEvent = vi.fn();

    const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
      event_limits: { max_events: 6 },
      onEvent,
    });

    expect(result).toMatchObject({ status: 'failed', exit_code: 4, cases: [] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      event: 'result',
      data: {
        exit_code: 4,
        result: { ok: false, error: { code: 'run_failed', retryable: true } },
      },
    });
    expect(onEvent).toHaveBeenCalledWith(result.events[0]);
    expect(executeCase).not.toHaveBeenCalled();
    expect(persistence.createRun).not.toHaveBeenCalled();
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });

  it('returns finalized failure state when a terminal event exceeds the runtime byte cap', async () => {
    const plan = createPlan(['case-zero']);
    const persistence = createPersistence();
    const runner: EvalCaseRunner<string> = {
      executeCase: (_runId, resolvedCase) =>
        Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
    };
    let clockCalls = 0;
    const now = (): string => {
      clockCalls += 1;
      return clockCalls === 4 ? 'x'.repeat(2_000) : '2026-08-08T10:00:00.000Z';
    };

    const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now,
      event_limits: { max_event_bytes: 1_024 },
    });

    expect(result.status).toBe('failed');
    expect(result.exit_code).toBe(4);
    expect(result.can_release_cancellation_ownership).toBe(true);
    expect(persistence.finalizeRun).toHaveBeenLastCalledWith(RUN_ID, 'failed', result.summary);
  });

  it('returns the baseline diff and atomically publishes deterministic JUnit payload bytes', async () => {
    const plan = createPlan(['case-zero'], { baseline: true, junit: true });
    const runner: EvalCaseRunner<string> = {
      executeCase: (_runId, resolvedCase) =>
        Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
    };
    const diff = { summary: { regressions: 0 } };
    const diffRuns = vi.fn(() => Promise.resolve(diff));
    const writeJUnitAtomically = vi.fn(() => Promise.resolve());
    const baseline = { diffRuns };
    const artifacts = { writeJUnitAtomically };

    const persistence = createPersistence();
    const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
      baseline,
      artifacts,
    });

    expect(result.exit_code).toBe(0);
    expect(result.baseline_diff).toEqual(diff);
    expect(result.junit?.byte_length).toBeGreaterThan(0);
    expect(result.junit?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.junit?.contents).toContain('<testsuite name="refund" tests="1"');
    expect(diffRuns).toHaveBeenCalledWith({
      baselineRunId: BASELINE_RUN_ID,
      candidateRunId: RUN_ID,
    });
    expect(writeJUnitAtomically).toHaveBeenCalledWith('artifacts/results.xml', result.junit);
  });

  it('classifies an atomic JUnit write failure as infrastructure and still emits one final result', async () => {
    const plan = createPlan(['case-zero'], { baseline: true, junit: true });
    const persistence = createPersistence();
    const runner: EvalCaseRunner<string> = {
      executeCase: (_runId, resolvedCase) =>
        Promise.resolve(completedExecution(resolvedCase, [passingMetric()])),
    };

    const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      now: createClock(),
      baseline: { diffRuns: () => Promise.resolve({ stable: true }) },
      artifacts: {
        writeJUnitAtomically: () => Promise.reject(new Error('rename failed')),
      },
    });

    expect(result.status).toBe('failed');
    expect(result.exit_code).toBe(4);
    expect(result.events.filter(({ event }) => event === 'result')).toHaveLength(1);
    expect(result.events.at(-1)).toMatchObject({ event: 'result', data: { exit_code: 4 } });
    expect(persistence.finalizeRun).toHaveBeenCalledWith(RUN_ID, 'failed', result.summary);
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
  });
});

describe('runtime hooks and isolated stages', () => {
  it('keeps the environment alive through all stages and isolates concurrent cases', async () => {
    const stages = new Map<string, string[]>();
    const runStages: string[] = [];
    const plan = createPlan(['one', 'two']);
    const runner = createStagedCaseRunner<string>({
      invoke: async ({ resolvedCase, environment }) => {
        stages.get(resolvedCase.case_id)!.push('invoke');
        expect(await environment!.readFile('case.txt')).toBe(resolvedCase.case_id);
        return completedExecution(resolvedCase, []).execution;
      },
      evaluate: async ({ resolvedCase, environment }) => {
        stages.get(resolvedCase.case_id)!.push('evaluate');
        expect(await environment!.readFile('after-agent.txt')).toBe('ready');
        return [];
      },
    });
    const result = await executeResolvedEvalPlan(plan, runner, createPersistence().adapter, {
      isolation: justBashIsolation(),
      hooks: [
        {
          before_run: () => {
            runStages.push('before');
          },
          before_case: async ({ resolvedCase, environment, caseState }) => {
            stages.set(resolvedCase.case_id, ['before']);
            caseState.set('id', resolvedCase.case_id);
            await environment!.writeFile('case.txt', resolvedCase.case_id);
          },
          after_agent: async ({ resolvedCase, environment }) => {
            stages.get(resolvedCase.case_id)!.push('after_agent');
            await environment!.writeFile('after-agent.txt', 'ready');
          },
          after_evaluation: ({ resolvedCase }) => {
            stages.get(resolvedCase.case_id)!.push('after_evaluation');
          },
          after_case: async ({ resolvedCase, environment, caseState }) => {
            expect(caseState.get('id')).toBe(resolvedCase.case_id);
            expect(await environment!.readFile('case.txt')).toBe(resolvedCase.case_id);
            stages.get(resolvedCase.case_id)!.push('after');
          },
          after_run: ({ status }) => {
            runStages.push(status);
          },
        },
      ],
    });
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
    const after = vi.fn();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>();
    const result = await executeResolvedEvalPlan(
      createPlan(['one']),
      { executeCase },
      createPersistence().adapter,
      {
        isolation: () =>
          Promise.resolve({
            kind: 'fake',
            exec: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn(),
            dispose,
          }),
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
        executeCase: (_runId, resolvedCase) =>
          Promise.resolve(completedExecution(resolvedCase, [])),
        cleanup: () => Promise.reject(runnerCleanupFailure),
      },
      [],
    );

    await expect(wrapped.beforeRun?.(RUN_ID, new AbortController().signal)).rejects.toBe(
      setupFailure,
    );
    const cleanup = await wrapped.cleanup?.(RUN_ID).catch((error: unknown) => error);
    expect(cleanup).toBeInstanceOf(AggregateError);
    expect((cleanup as AggregateError).errors).toEqual([setupFailure, runnerCleanupFailure]);
    expect(cleanup).toMatchObject({ cleanupConfirmed: false });
  });

  it('clones frozen evidence and retains every finalization failure before disposal', async () => {
    const plan = createPlan(['one']);
    const finalization: string[] = [];
    const original = completedExecution(plan.cases[0]!, [passingMetric()]);
    Object.freeze(original.execution.diagnostics);
    Object.freeze(original.execution);
    Object.freeze(original.metrics);
    Object.freeze(original);
    const persistence = createPersistence();
    const result = await executeResolvedEvalPlan(
      plan,
      { executeCase: () => Promise.resolve(original) },
      persistence.adapter,
      {
        isolation: () =>
          Promise.resolve({
            kind: 'fake',
            exec: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn(),
            beginFinalization: () => {
              finalization.push('begin');
              return Promise.reject(
                new Error(`finalization transition failed ${'x'.repeat(5000)}`),
              );
            },
            dispose: () => {
              finalization.push('dispose');
              return Promise.reject(new Error('environment disposal failed'));
            },
          }),
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
    expect(result.status).toBe('failed');
    const record = result.cases[0]!;
    if (record.kind !== 'executed') throw new Error('Expected executed evidence.');
    expect(record.normalized.verdict).toBe('error');
    expect(record.execution).not.toBe(original.execution);
    expect(record.metrics).not.toBe(original.metrics);
    expect(record.execution.diagnostics.lifecycleError).toContain('finalization transition failed');
    expect(record.execution.diagnostics.lifecycleError).toContain('first after_case failed');
    expect(record.execution.diagnostics.lifecycleError).toContain('environment disposal failed');
    expect(record.execution.diagnostics.lifecycleError).toHaveLength(4096);
    expect(record.execution.diagnostics.lifecycleError?.endsWith(' [truncated]')).toBe(true);
    expect(persistence.recordCase).toHaveBeenCalledWith(RUN_ID, record);
    expect(result.can_release_cancellation_ownership).toBe(false);
    expect(result.summary.error_cases).toBe(1);
  });

  it('releases cleanup ownership when disposal confirms a failed finalization transition', async () => {
    const plan = createPlan(['one']);
    const dispose = vi.fn(() => Promise.resolve());
    const result = await executeResolvedEvalPlan(
      plan,
      {
        executeCase: (_runId, resolvedCase) =>
          Promise.resolve(completedExecution(resolvedCase, [])),
      },
      createPersistence().adapter,
      {
        isolation: () =>
          Promise.resolve({
            kind: 'fake',
            exec: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn(),
            beginFinalization: () => Promise.reject(new Error('transition failed')),
            dispose,
          }),
      },
    );

    expect(result.status).toBe('failed');
    expect(result.can_release_cancellation_ownership).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(result.cases[0]).toMatchObject({
      kind: 'executed',
      normalized: { verdict: 'error' },
      execution: { diagnostics: { lifecycleError: 'transition failed' } },
    });
  });

  it.each([
    { stage: 'after_agent' as const, expectedMetrics: 0 },
    { stage: 'after_evaluation' as const, expectedMetrics: 1 },
  ])('preserves completed evidence when $stage fails', async ({ stage, expectedMetrics }) => {
    const plan = createPlan(['one']);
    const evaluate = vi.fn(() => Promise.resolve([passingMetric()]));
    const persistence = createPersistence();
    const runner = createStagedCaseRunner<string>({
      invoke: ({ resolvedCase }) => Promise.resolve(completedExecution(resolvedCase, []).execution),
      evaluate,
    });
    const result = await executeResolvedEvalPlan(plan, runner, persistence.adapter, {
      hooks: [
        {
          [stage]: () => {
            throw new Error(`${stage} failed`);
          },
        },
      ],
    });

    expect(result.status).toBe('failed');
    const record = result.cases[0]!;
    expect(record.kind).toBe('executed');
    if (record.kind !== 'executed') throw new Error('Expected executed evidence.');
    expect(record.execution.attempts).toHaveLength(1);
    expect(record.metrics).toHaveLength(expectedMetrics);
    expect(record.execution.diagnostics.lifecycleError).toContain(`${stage} failed`);
    expect(evaluate).toHaveBeenCalledTimes(stage === 'after_agent' ? 0 : 1);
    expect(persistence.recordCase).toHaveBeenCalledWith(RUN_ID, record);
    expect(record.normalized.verdict).toBe('error');
    expect(result.summary.error_cases).toBe(1);
  });

  it('admits another test while an earlier test is at its cap', async () => {
    const plan = createPlan(['a1', 'a2', 'b1'], { concurrency: 2, testConcurrency: 1 });
    plan.cases[2]!.test_id = 'other';
    plan.run.snapshot.selected_cases[2]!.test_id = 'other';
    const first = deferred<ReturnType<typeof completedExecution>>();
    const starts: string[] = [];
    const execution = executeResolvedEvalPlan(
      plan,
      {
        executeCase: async (_runId, resolvedCase) => {
          starts.push(resolvedCase.case_id);
          return resolvedCase.case_id === 'a1'
            ? first.promise
            : completedExecution(resolvedCase, []);
        },
      },
      createPersistence().adapter,
    );
    await vi.waitFor(() => expect(starts).toEqual(['a1', 'b1']));
    first.resolve(completedExecution(plan.cases[0]!, []));
    expect((await execution).status).toBe('completed');
    expect(starts).toEqual(['a1', 'b1', 'a2']);
  });

  it('contains synchronous runner throws and preserves other case results', async () => {
    const result = await executeResolvedEvalPlan(
      createPlan(['bad', 'good']),
      {
        executeCase: (_runId, resolvedCase) => {
          if (resolvedCase.case_id === 'bad') throw new Error('synchronous');
          return Promise.resolve(completedExecution(resolvedCase, []));
        },
      },
      createPersistence().adapter,
    );
    expect(result.cases).toHaveLength(2);
    expect(result.cases.some((record) => record.kind === 'executed')).toBe(true);
    expect(result.status).toBe('failed');
  });
});
