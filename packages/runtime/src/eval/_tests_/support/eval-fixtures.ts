import { readFileSync } from 'node:fs';

import { evalRunSchema, type EvalRun } from '@attest/contracts';
import type { StoredMetricEvaluation } from '@attest/core';
import { AgentInvocationError, type CaseExecution } from '@attest/executor';
import { vi } from 'vitest';

import type {
  EvalCaseRunner,
  EvalCaseRunnerResult,
  EvalPersistenceAdapter,
  ResolvedEvalCase,
  ResolvedEvalPlan,
} from '../../types.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BASELINE_RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';

const baseRun = evalRunSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/eval-run.json', import.meta.url), 'utf8')),
);

type CaseSpec = { caseId: string; testId?: string; testConcurrency?: number };

type PlanOptions = {
  baseline?: boolean;
  junit?: boolean;
  concurrency?: number;
  testConcurrency?: number;
  timeoutMs?: number;
  workers?: number;
};

/** Builds a contract-valid run over the given cases, defaulting every case to the `refund` test. */
const createPlan = (
  cases: readonly (string | CaseSpec)[],
  options: PlanOptions = {},
): ResolvedEvalPlan<string> => {
  const specs = cases.map((spec) => (typeof spec === 'string' ? { caseId: spec } : spec));
  const selectedCases = specs.map((spec, configuredIndex) => ({
    configured_index: configuredIndex,
    test_id: spec.testId ?? 'refund',
    case_id: spec.caseId,
    source: { kind: 'direct' as const },
  }));
  const concurrency = options.concurrency ?? 2;
  const baselineRunId = options.baseline === true ? BASELINE_RUN_ID : undefined;
  const junitPath = options.junit === true ? 'artifacts/results.xml' : undefined;
  const run: EvalRun = {
    ...structuredClone(baseRun),
    snapshot: {
      ...structuredClone(baseRun.snapshot),
      selected_test_ids: [...new Set(selectedCases.map(({ test_id }) => test_id))],
      selected_cases: selectedCases,
    },
  };
  run.effective_command.resolved = {
    concurrency,
    timeout_ms: options.timeoutMs ?? 60_000,
    output: 'jsonl',
    watch: false,
    baseline_run_id: baselineRunId,
    junit_path: junitPath,
    execution:
      options.workers === undefined
        ? undefined
        : {
            workers: {
              count: options.workers,
              directory: '.attest/runs/{run_id}/workers/{worker_index}',
            },
          },
  };
  return {
    run,
    cases: selectedCases.map((selectedCase, index) => ({
      ...selectedCase,
      test_concurrency: specs[index]?.testConcurrency ?? options.testConcurrency,
      payload: selectedCase.case_id,
    })),
  };
};

/** Provides a monotonic injected ISO clock so event snapshots never depend on wall time. */
const createClock = (): (() => string) => {
  let milliseconds = 0;
  return () => new Date(Date.UTC(2026, 7, 8, 10, 0, 0, milliseconds++)).toISOString();
};

const caseRequest = (resolvedCase: ResolvedEvalCase<string>) => ({
  protocol: 'attest.agent-invocation' as const,
  run_id: RUN_ID,
  case_id: resolvedCase.case_id,
  input: { prompt: resolvedCase.payload },
});

/** A successful runner result carrying the given metric evidence. */
const completedExecution = (
  resolvedCase: ResolvedEvalCase<string>,
  metrics: readonly StoredMetricEvaluation[] = [],
): EvalCaseRunnerResult => ({
  execution: {
    caseId: resolvedCase.case_id,
    suiteName: resolvedCase.test_id,
    request: caseRequest(resolvedCase),
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
  } satisfies CaseExecution,
  metrics,
});

/** An invocation failure in a real runner result shape. */
const failedExecution = (
  resolvedCase: ResolvedEvalCase<string>,
  outcome: 'invocation_error' | 'timeout' | 'cancelled' = 'invocation_error',
): EvalCaseRunnerResult => {
  const code = outcome === 'invocation_error' ? 'network' : outcome;
  const invocationError = new AgentInvocationError(code, `${resolvedCase.case_id} ${outcome}`);
  return {
    execution: {
      caseId: resolvedCase.case_id,
      suiteName: resolvedCase.test_id,
      request: caseRequest(resolvedCase),
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

/** A runner case that waits for its signal to abort, then reports a cancelled invocation. */
const waitForAbort: EvalCaseRunner<string>['executeCase'] = async (
  _runId,
  resolvedCase,
  signal,
) => {
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }
  return failedExecution(resolvedCase, 'cancelled');
};

export {
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
};
