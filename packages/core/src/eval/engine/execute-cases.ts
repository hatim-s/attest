import { normalizeCaseResult } from '../normalization.js';
import type {
  EvalCaseInfrastructureFailure,
  EvalCaseRecord,
  EvalCaseRunner,
  EvalPersistenceAdapter,
  ImmutableEvalRun,
  ResolvedEvalCase,
} from '../types.js';
import type { EventCollector } from './event-collector.js';
import { safeErrorMessage } from './run-model.js';

type SettledCase<Payload> = {
  resolvedCase: ResolvedEvalCase<Payload>;
  workerIndex: number;
  result:
    | { status: 'fulfilled'; value: Awaited<ReturnType<EvalCaseRunner<Payload>['executeCase']>> }
    | { status: 'rejected'; reason: unknown };
};

type CaseExecutionState<Payload> = {
  records: EvalCaseRecord<Payload>[];
  infrastructureErrors: string[];
};

/** Starts one runner task with the worker identity that remains stable for its full execution. */
const startCase = <Payload>(
  run: ImmutableEvalRun,
  resolvedCase: ResolvedEvalCase<Payload>,
  runner: EvalCaseRunner<Payload>,
  signal: AbortSignal,
  workerIndex: number,
): Promise<SettledCase<Payload>> =>
  runner.executeCase(run.run_id, resolvedCase, signal, { worker_index: workerIndex }).then(
    (value): SettledCase<Payload> => ({
      resolvedCase,
      workerIndex,
      result: { status: 'fulfilled', value },
    }),
    (reason: unknown): SettledCase<Payload> => ({
      resolvedCase,
      workerIndex,
      result: { status: 'rejected', reason },
    }),
  );

/** Normalizes, persists, and emits one settled case in observed completion order. */
const recordSettledCase = async <Payload>(
  run: ImmutableEvalRun,
  settled: SettledCase<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
  state: CaseExecutionState<Payload>,
): Promise<void> => {
  const completionIndex = state.records.length;
  let record: EvalCaseRecord<Payload>;

  if (
    settled.result.status === 'fulfilled' &&
    settled.result.value.execution.caseId === settled.resolvedCase.case_id
  ) {
    const { execution, metrics } = settled.result.value;
    if (settled.result.value.lifecycle_error !== undefined) {
      state.infrastructureErrors.push(settled.result.value.lifecycle_error);
    }
    record = {
      kind: 'executed',
      resolved_case: settled.resolvedCase,
      execution,
      metrics,
      normalized: normalizeCaseResult(settled.resolvedCase, execution, metrics, completionIndex),
    };
  } else {
    const cancellation = signal.aborted;
    const reason =
      settled.result.status === 'rejected'
        ? settled.result.reason
        : new Error(
            `Runner case id ${settled.result.value.execution.caseId} does not match ${settled.resolvedCase.case_id}.`,
          );
    const error: EvalCaseInfrastructureFailure = {
      code: 'eval_case_runner_failed',
      message: safeErrorMessage(reason, 'Eval case runner failed.'),
    };
    state.infrastructureErrors.push(error.message);
    record = {
      kind: 'infrastructure_error',
      resolved_case: settled.resolvedCase,
      error,
      normalized: {
        test_id: settled.resolvedCase.test_id,
        case_id: settled.resolvedCase.case_id,
        configured_index: settled.resolvedCase.configured_index,
        completion_index: completionIndex,
        outcome: cancellation ? 'cancelled' : 'invocation_error',
        verdict: 'error',
        started_at: run.created_at,
        duration_ms: 0,
        attempts: [],
        metric_results: [],
      },
    };
  }

  state.records.push(record);
  try {
    await persistence.recordCase(run.run_id, record);
  } catch (error: unknown) {
    state.infrastructureErrors.push(safeErrorMessage(error, 'Eval case persistence failed.'));
  }
  await emit({
    event: 'case_completed',
    data: {
      run_id: run.run_id,
      test_id: record.normalized.test_id,
      case_id: record.normalized.case_id,
      configured_index: record.normalized.configured_index,
      completion_index: record.normalized.completion_index,
      outcome: record.normalized.outcome,
      verdict: record.normalized.verdict,
    },
  });
};

/** Divides configured cases into balanced contiguous batches, assigning extra cases from the front. */
const createWorkerBatches = <Payload>(
  cases: readonly ResolvedEvalCase<Payload>[],
  requestedWorkers: number,
): readonly (readonly ResolvedEvalCase<Payload>[])[] => {
  const workerCount = Math.min(requestedWorkers, cases.length);
  if (workerCount === 0) return [];
  const minimumBatchSize = Math.floor(cases.length / workerCount);
  const workersWithExtraCase = cases.length % workerCount;
  let offset = 0;
  return Array.from({ length: workerCount }, (_, workerIndex) => {
    const size = minimumBatchSize + (workerIndex < workersWithExtraCase ? 1 : 0);
    const batch = cases.slice(offset, offset + size);
    offset += size;
    return batch;
  });
};

/** Runs one serial queue per explicit worker while processing completions through one ordered sink. */
const executeWorkerBatches = async <Payload>(
  run: ImmutableEvalRun,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
  requestedWorkers: number,
): Promise<CaseExecutionState<Payload>> => {
  const batches = createWorkerBatches(cases, requestedWorkers);
  const pending = new Map<number, Promise<SettledCase<Payload>>>();
  const nextIndexByWorker = batches.map(() => 0);
  const workerFailures = new Map<number, string>();
  const state: CaseExecutionState<Payload> = { records: [], infrastructureErrors: [] };

  const scheduleWorker = async (workerIndex: number): Promise<void> => {
    const batch = batches[workerIndex];
    const batchIndex = nextIndexByWorker[workerIndex] ?? 0;
    const resolvedCase = batch?.[batchIndex];
    if (resolvedCase === undefined) return;
    nextIndexByWorker[workerIndex] = batchIndex + 1;
    await emit({
      event: 'case_started',
      data: {
        run_id: run.run_id,
        test_id: resolvedCase.test_id,
        case_id: resolvedCase.case_id,
        configured_index: resolvedCase.configured_index,
      },
    });
    const workerFailure = workerFailures.get(workerIndex);
    pending.set(
      workerIndex,
      workerFailure === undefined
        ? startCase(run, resolvedCase, runner, signal, workerIndex)
        : Promise.resolve({
            resolvedCase,
            workerIndex,
            result: { status: 'rejected' as const, reason: new Error(workerFailure) },
          }),
    );
  };

  // Launch the first case in configured worker order so simultaneous starts remain deterministic.
  for (let workerIndex = 0; workerIndex < batches.length; workerIndex += 1) {
    await scheduleWorker(workerIndex);
  }
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.workerIndex);
    await recordSettledCase(run, settled, persistence, signal, emit, state);
    if (settled.result.status === 'rejected') {
      workerFailures.set(
        settled.workerIndex,
        safeErrorMessage(settled.result.reason, 'The worker case failed.'),
      );
    } else if (settled.result.value.lifecycle_error !== undefined) {
      workerFailures.set(settled.workerIndex, settled.result.value.lifecycle_error);
    }
    await scheduleWorker(settled.workerIndex);
  }

  return state;
};

/** Runs the existing bounded case pool and assigns each active task a transient worker slot. */
const executeConcurrentCases = async <Payload>(
  run: ImmutableEvalRun,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
): Promise<CaseExecutionState<Payload>> => {
  const concurrency = run.effective_command.resolved.concurrency;
  const pending = new Map<number, Promise<SettledCase<Payload>>>();
  const activeByTest = new Map<string, number>();
  const activeWorkerIndexes = new Set<number>();
  const state: CaseExecutionState<Payload> = { records: [], infrastructureErrors: [] };
  let nextIndex = 0;

  const acquireWorkerIndex = (): number => {
    for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
      if (!activeWorkerIndexes.has(workerIndex)) {
        activeWorkerIndexes.add(workerIndex);
        return workerIndex;
      }
    }
    throw new Error('Eval concurrency slot accounting drifted.');
  };

  const schedule = async (): Promise<void> => {
    while (pending.size < concurrency && nextIndex < cases.length) {
      const resolvedCase = cases[nextIndex] as ResolvedEvalCase<Payload>;
      const testConcurrency = resolvedCase.test_concurrency ?? concurrency;
      const activeForTest = activeByTest.get(resolvedCase.test_id) ?? 0;
      // Retain legacy scheduling when one test reaches its narrower concurrency cap.
      if (activeForTest >= testConcurrency) break;
      nextIndex += 1;
      const workerIndex = acquireWorkerIndex();
      await emit({
        event: 'case_started',
        data: {
          run_id: run.run_id,
          test_id: resolvedCase.test_id,
          case_id: resolvedCase.case_id,
          configured_index: resolvedCase.configured_index,
        },
      });
      const task = startCase(run, resolvedCase, runner, signal, workerIndex);
      pending.set(resolvedCase.configured_index, task);
      activeByTest.set(resolvedCase.test_id, activeForTest + 1);
    }
  };

  await schedule();
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.resolvedCase.configured_index);
    activeWorkerIndexes.delete(settled.workerIndex);
    const activeForTest = activeByTest.get(settled.resolvedCase.test_id) ?? 1;
    if (activeForTest <= 1) activeByTest.delete(settled.resolvedCase.test_id);
    else activeByTest.set(settled.resolvedCase.test_id, activeForTest - 1);
    await recordSettledCase(run, settled, persistence, signal, emit, state);
    await schedule();
  }

  return state;
};

/** Selects explicit stable workers or the legacy bounded concurrency scheduler. */
const executeCases = async <Payload>(
  run: ImmutableEvalRun,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
): Promise<CaseExecutionState<Payload>> => {
  const workers = run.effective_command.resolved.execution?.workers;
  return workers === undefined
    ? executeConcurrentCases(run, cases, runner, persistence, signal, emit)
    : executeWorkerBatches(run, cases, runner, persistence, signal, emit, workers.count);
};

export { executeCases };
