import type { EvalRun } from '@attest/contracts';
import { evalEventStreamSchema } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { MetricEvaluation } from '../../metrics/metric-evaluation.js';
import { AgentInvocationError } from '../../runner/errors.js';
import type { CaseExecution } from '../../runner/types.js';
import { executeResolvedEvalPlan } from '../engine.js';
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
  metrics: readonly MetricEvaluation[],
): { execution: CaseExecution; metrics: readonly MetricEvaluation[] } => ({
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
): { execution: CaseExecution; metrics: readonly MetricEvaluation[] } => {
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

const passingMetric = (name = 'correct'): MetricEvaluation => ({
  metricName: name,
  kind: 'assertion',
  status: 'evaluated',
  result: { score: 1, pass: true },
  durationMs: 0,
});

const failingMetric = (name = 'correct'): MetricEvaluation => ({
  metricName: name,
  kind: 'assertion',
  status: 'evaluated',
  result: { score: 0, pass: false, rationale: 'expected mismatch' },
  durationMs: 0,
});

const errorMetric = (name = 'correct'): MetricEvaluation => ({
  metricName: name,
  kind: 'assertion',
  status: 'error',
  error: { code: 'internal_error', message: 'metric adapter failed' },
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
    expect(executeCase).toHaveBeenCalledOnce();
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
    expect(cleanup).toHaveBeenCalledOnce();
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

    expect(observedSignals).toHaveLength(3);
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

  it('records synchronous runner failures while draining the remaining case pool', async () => {
    const plan = createPlan(['passes', 'throws', 'also-passes'], { concurrency: 2 });
    const persistence = createPersistence();
    const cleanup = vi.fn(() => Promise.resolve());
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>((_runId, resolvedCase) => {
      if (resolvedCase.case_id === 'throws') throw new Error('adapter setup failed');
      return Promise.resolve(completedExecution(resolvedCase, [passingMetric()]));
    });

    const result = await executeResolvedEvalPlan(
      plan,
      { executeCase, cleanup },
      persistence.adapter,
      { now: createClock() },
    );

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 4,
      summary: { total_cases: 3, passed_cases: 2, error_cases: 1 },
    });
    expect(persistence.recordCase).toHaveBeenCalledTimes(3);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(evalEventStreamSchema.safeParse(result.events).success).toBe(true);
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
