import type { EvalRun } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import { executeCases } from '../engine/execute-cases.js';
import { executeResolvedEvalPlan } from '../engine/execute-eval.js';
import { freezeEvalRun } from '../engine/run-model.js';
import type {
  CaseExecution,
  EvalCaseRunner,
  EvalPersistenceAdapter,
  ResolvedEvalCase,
  ResolvedEvalPlan,
} from '../types.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PROJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAB';

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
};

type CaseSpec = {
  caseId: string;
  testId: string;
  testConcurrency?: number;
};

/** Creates a promise whose completion can be placed precisely in scheduler tests. */
const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

/** Builds the smallest valid resolved plan needed to exercise runtime scheduling. */
const createPlan = (specs: readonly CaseSpec[], concurrency: number): ResolvedEvalPlan<string> => {
  const selectedCases = specs.map(({ caseId, testId }, configuredIndex) => ({
    configured_index: configuredIndex,
    test_id: testId,
    case_id: caseId,
    source: { kind: 'direct' as const },
  }));
  const run: EvalRun = {
    schema: 'attest.eval-run',
    run_id: RUN_ID,
    created_at: '2026-09-22T00:00:00.000Z',
    snapshot_hash: 'f'.repeat(64),
    snapshot: {
      project_id: PROJECT_ID,
      project_hash: 'a'.repeat(64),
      resource_hashes: { agents: [], tests: [], datasets: [], metrics: [] },
      selected_test_ids: [...new Set(specs.map(({ testId }) => testId))],
      selected_cases: selectedCases,
    },
    effective_command: {
      command_path: ['eval', 'run'],
      argv: ['eval', 'run'],
      request: {
        schema: 'attest.command-request',
        command: 'eval.run',
        test_ids: [...new Set(specs.map(({ testId }) => testId))],
        output: 'jsonl',
      },
      resolved: {
        concurrency,
        timeout_ms: 60_000,
        output: 'jsonl',
        watch: false,
      },
    },
  };
  return {
    run,
    cases: selectedCases.map((selectedCase, index) => ({
      ...selectedCase,
      ...(specs[index]!.testConcurrency === undefined
        ? {}
        : { test_concurrency: specs[index]!.testConcurrency }),
      payload: selectedCase.case_id,
    })),
  };
};

/** Produces one valid successful runner result without metric work. */
const completedExecution = (
  resolvedCase: ResolvedEvalCase<string>,
): Awaited<ReturnType<EvalCaseRunner<string>['executeCase']>> => ({
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
        status: 'ok',
        raw: { protocol: 'attest.agent-invocation', output: resolvedCase.payload },
        diagnostics: {},
        durationMs: 1,
        warnings: [],
      },
    ],
    diagnostics: {},
    warnings: [],
    startedAt: '2026-09-22T00:00:00.000Z',
    durationMs: 1,
    outcome: 'completed',
    response: { protocol: 'attest.agent-invocation', output: resolvedCase.payload },
  } satisfies CaseExecution,
  metrics: [],
});

/** Captures scheduler persistence without a database. */
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

describe('executeCases scheduler', () => {
  it('admits the earliest eligible test queue while another test is capped', async () => {
    const plan = createPlan(
      [
        { caseId: 'a-1', testId: 'a', testConcurrency: 1 },
        { caseId: 'a-2', testId: 'a', testConcurrency: 1 },
        { caseId: 'b-1', testId: 'b', testConcurrency: 1 },
        { caseId: 'c-1', testId: 'c', testConcurrency: 1 },
      ],
      3,
    );
    const pending = new Map<string, Deferred<ReturnType<typeof completedExecution>>>();
    const starts: string[] = [];
    const runner: EvalCaseRunner<string> = {
      executeCase: (_runId, resolvedCase) => {
        starts.push(resolvedCase.case_id);
        const completion = deferred<ReturnType<typeof completedExecution>>();
        pending.set(resolvedCase.case_id, completion);
        return completion.promise;
      },
    };
    const persistence = createPersistence();

    const execution = executeCases(
      freezeEvalRun(plan.run),
      plan.cases,
      runner,
      persistence.adapter,
      new AbortController().signal,
      () => Promise.resolve(),
    );
    await vi.waitFor(() => expect(starts).toEqual(['a-1', 'b-1', 'c-1']));
    pending.get('b-1')!.resolve(completedExecution(plan.cases[2]!));
    await vi.waitFor(() => expect(persistence.recordCase).toHaveBeenCalledOnce());
    expect(starts).toEqual(['a-1', 'b-1', 'c-1']);

    pending.get('a-1')!.resolve(completedExecution(plan.cases[0]!));
    await vi.waitFor(() => expect(starts.at(-1)).toBe('a-2'));
    pending.get('c-1')!.resolve(completedExecution(plan.cases[3]!));
    pending.get('a-2')!.resolve(completedExecution(plan.cases[1]!));

    const result = await execution;
    expect(result.records).toHaveLength(4);
    expect(result.persistenceConfirmed).toBe(true);
  });

  it('drains and records every case after a completion event fails', async () => {
    const plan = createPlan(
      [
        { caseId: 'one', testId: 'one' },
        { caseId: 'two', testId: 'two' },
        { caseId: 'three', testId: 'three' },
      ],
      2,
    );
    const persistence = createPersistence();
    const result = await executeCases(
      freezeEvalRun(plan.run),
      plan.cases,
      {
        executeCase: (_runId, resolvedCase) => Promise.resolve(completedExecution(resolvedCase)),
      },
      persistence.adapter,
      new AbortController().signal,
      (event) => {
        if (event.event === 'case_completed') throw new Error('event is too large');
        return Promise.resolve();
      },
    );

    expect(result.records).toHaveLength(3);
    expect(result.infrastructureErrors).toEqual([
      'event is too large',
      'event is too large',
      'event is too large',
    ]);
    expect(persistence.recordCase).toHaveBeenCalledTimes(3);
  });

  it('classifies rejection from settlement time and does not invoke queued work after abort', async () => {
    const plan = createPlan(
      [
        { caseId: 'settled-before-abort', testId: 'test' },
        { caseId: 'queued-at-abort', testId: 'test' },
      ],
      1,
    );
    const controller = new AbortController();
    const secondStart = deferred<void>();
    const releaseSecondStart = deferred<void>();
    const executeCase = vi
      .fn<EvalCaseRunner<string>['executeCase']>()
      .mockRejectedValue(new Error('failed before abort'));

    const execution = executeCases(
      freezeEvalRun(plan.run),
      plan.cases,
      { executeCase },
      createPersistence().adapter,
      controller.signal,
      async (event) => {
        if (
          event.event === 'case_started' &&
          'case_id' in event.data &&
          event.data.case_id === 'queued-at-abort'
        ) {
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

describe('executeResolvedEvalPlan scheduler durability', () => {
  it('fails and retains cancellation ownership when any case record is not durable', async () => {
    const plan = createPlan(
      [
        { caseId: 'active', testId: 'test' },
        { caseId: 'queued', testId: 'test' },
      ],
      1,
    );
    const controller = new AbortController();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>(
      async (_runId, _resolvedCase, signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        throw new Error('runner cancelled');
      },
    );
    const persistence = createPersistence();
    persistence.recordCase.mockRejectedValue(new Error('case row unavailable'));

    const execution = executeResolvedEvalPlan(plan, { executeCase }, persistence.adapter, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(executeCase).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    const result = await execution;

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 4,
      can_release_cancellation_ownership: false,
    });
    expect(result.cases).toHaveLength(2);
    expect(persistence.finalizeRun).toHaveBeenLastCalledWith(RUN_ID, 'failed', result.summary);
  });

  it('keeps a completion event when a later clock value exceeds the byte cap', async () => {
    const plan = createPlan([{ caseId: 'one', testId: 'test' }], 1);
    let clockCalls = 0;
    const result = await executeResolvedEvalPlan(
      plan,
      {
        executeCase: (_runId, resolvedCase) => Promise.resolve(completedExecution(resolvedCase)),
      },
      createPersistence().adapter,
      {
        now: () => {
          clockCalls += 1;
          return clockCalls === 4 ? 'x'.repeat(2_000) : '2026-09-22T00:00:00.000Z';
        },
        event_limits: { max_event_bytes: 1_024 },
      },
    );

    expect(result.status).toBe('failed');
    expect(result.cases).toHaveLength(1);
    expect(result.events.filter(({ event }) => event === 'case_started')).toHaveLength(1);
    expect(result.events.filter(({ event }) => event === 'case_completed')).toHaveLength(1);
    expect(
      result.events.every((event) => Buffer.byteLength(JSON.stringify(event), 'utf8') <= 1_024),
    ).toBe(true);
  });

  it('uses the runtime event timestamp when checking byte limits before persistence', async () => {
    const plan = createPlan([{ caseId: 'one', testId: 'test' }], 1);
    const persistence = createPersistence();
    const executeCase = vi.fn<EvalCaseRunner<string>['executeCase']>();

    const result = await executeResolvedEvalPlan(plan, { executeCase }, persistence.adapter, {
      now: () => 'x'.repeat(2_000),
      event_limits: { max_event_bytes: 1_024 },
    });

    expect(result).toMatchObject({ status: 'failed', exit_code: 4, cases: [] });
    expect(Buffer.byteLength(JSON.stringify(result.events[0]), 'utf8')).toBeLessThanOrEqual(1_024);
    expect(persistence.createRun).not.toHaveBeenCalled();
    expect(executeCase).not.toHaveBeenCalled();
  });
});
