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
  cancelledAtSettlement: boolean;
  result:
    | { status: 'fulfilled'; value: Awaited<ReturnType<EvalCaseRunner<Payload>['executeCase']>> }
    | { status: 'rejected'; reason: unknown };
};

type CaseExecutionState<Payload> = {
  records: EvalCaseRecord<Payload>[];
  infrastructureErrors: string[];
  persistenceConfirmed: boolean;
};

type TestQueue<Payload> = {
  cases: ResolvedEvalCase<Payload>[];
  next: number;
  active: number;
  limit: number;
};

/** Starts one runner task with the worker identity that remains stable for its full execution. */
const startCase = <Payload>(
  run: ImmutableEvalRun,
  resolvedCase: ResolvedEvalCase<Payload>,
  runner: EvalCaseRunner<Payload>,
  signal: AbortSignal,
  workerIndex: number,
): Promise<SettledCase<Payload>> =>
  Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      return runner.executeCase(run.run_id, resolvedCase, signal, { worker_index: workerIndex });
    })
    .then(
      (value) => ({
        resolvedCase,
        workerIndex,
        cancelledAtSettlement: signal.aborted,
        result: { status: 'fulfilled' as const, value },
      }),
      (reason: unknown) => ({
        resolvedCase,
        workerIndex,
        cancelledAtSettlement: signal.aborted,
        result: { status: 'rejected' as const, reason },
      }),
    );

/** Normalizes, persists, and emits one settled case in observed completion order. */
const recordSettledCase = async <Payload>(
  run: ImmutableEvalRun,
  settled: SettledCase<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
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
        outcome: settled.cancelledAtSettlement ? 'cancelled' : 'invocation_error',
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
    state.persistenceConfirmed = false;
    state.infrastructureErrors.push(safeErrorMessage(error, 'Eval case persistence failed.'));
  }
  try {
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
  } catch (error: unknown) {
    state.infrastructureErrors.push(safeErrorMessage(error, 'Eval case event emission failed.'));
  }
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

/** Queues each completion once, preserving finish order without attaching repeated race listeners. */
const createCompletionQueue = <Value>() => {
  const completed: Value[] = [];
  let wake: (() => void) | undefined;
  return {
    push(value: Value): void {
      completed.push(value);
      wake?.();
      wake = undefined;
    },
    async next(): Promise<Value> {
      if (completed.length === 0)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      const value = completed.shift();
      if (value === undefined) throw new Error('Missing eval completion.');
      return value;
    },
  };
};

/** Maintains eligible test queues by their next configured case without rescanning all tests. */
const createEligibleQueueHeap = <Payload>() => {
  const heap: TestQueue<Payload>[] = [];
  const enqueued = new Set<TestQueue<Payload>>();
  const configuredIndex = (queue: TestQueue<Payload>): number => {
    const resolvedCase = queue.cases[queue.next];
    if (resolvedCase === undefined) throw new Error('Eligible eval queue has no next case.');
    return resolvedCase.configured_index;
  };
  const enqueue = (queue: TestQueue<Payload>): void => {
    if (enqueued.has(queue) || queue.active >= queue.limit || queue.cases[queue.next] === undefined)
      return;

    enqueued.add(queue);
    let index = heap.length;
    heap.push(queue);
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = heap[parentIndex]!;
      if (configuredIndex(parent) <= configuredIndex(queue)) break;
      heap[index] = parent;
      index = parentIndex;
    }
    heap[index] = queue;
  };
  const dequeue = (): TestQueue<Payload> | undefined => {
    const first = heap[0];
    if (first === undefined) return undefined;

    const last = heap.pop()!;
    enqueued.delete(first);
    if (heap.length > 0) {
      let index = 0;
      while (true) {
        let childIndex = index * 2 + 1;
        if (childIndex >= heap.length) break;
        if (
          childIndex + 1 < heap.length &&
          configuredIndex(heap[childIndex + 1]!) < configuredIndex(heap[childIndex]!)
        )
          childIndex += 1;
        const child = heap[childIndex]!;
        if (configuredIndex(last) <= configuredIndex(child)) break;
        heap[index] = child;
        index = childIndex;
      }
      heap[index] = last;
    }
    return first;
  };

  return { dequeue, enqueue };
};

/** Admits eligible cases into bounded slots and drains every admitted task before returning. */
const executeCases = async <Payload>(
  run: ImmutableEvalRun,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
): Promise<CaseExecutionState<Payload>> => {
  const concurrency = Math.min(run.effective_command.resolved.concurrency, cases.length);
  const workers = run.effective_command.resolved.execution?.workers;
  const batches = workers === undefined ? undefined : createWorkerBatches(cases, workers.count);
  const queues = new Map<string, TestQueue<Payload>>();
  for (const resolvedCase of cases) {
    let queue = queues.get(resolvedCase.test_id);
    if (queue === undefined) {
      queue = {
        cases: [],
        next: 0,
        active: 0,
        limit: resolvedCase.test_concurrency ?? concurrency,
      };
      queues.set(resolvedCase.test_id, queue);
    }
    queue.limit = Math.min(queue.limit, resolvedCase.test_concurrency ?? concurrency);
    queue.cases.push(resolvedCase);
  }
  const nextByWorker = Array.from({ length: concurrency }, () => 0);
  const failures = new Map<number, string>();
  const pending = new Map<number, Promise<void>>();
  const completions = createCompletionQueue<SettledCase<Payload>>();
  const state: CaseExecutionState<Payload> = {
    records: [],
    infrastructureErrors: [],
    persistenceConfirmed: true,
  };
  const eligibleQueues = createEligibleQueueHeap<Payload>();
  if (batches === undefined) {
    for (const queue of queues.values()) eligibleQueues.enqueue(queue);
  }

  const takeCase = (workerIndex: number): ResolvedEvalCase<Payload> | undefined => {
    if (batches !== undefined) {
      const next = nextByWorker[workerIndex] ?? 0;
      nextByWorker[workerIndex] = next + 1;
      return batches[workerIndex]?.[next];
    }
    const queue = eligibleQueues.dequeue();
    if (queue === undefined) return undefined;
    const selected = queue.cases[queue.next];
    if (selected === undefined) throw new Error('Selected eval queue has no next case.');
    queue.next += 1;
    queue.active += 1;
    eligibleQueues.enqueue(queue);
    return selected;
  };
  const schedule = async (): Promise<void> => {
    for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
      if (pending.has(workerIndex)) continue;
      const resolvedCase = takeCase(workerIndex);
      if (resolvedCase === undefined) continue;
      try {
        await emit({
          event: 'case_started',
          data: {
            run_id: run.run_id,
            test_id: resolvedCase.test_id,
            case_id: resolvedCase.case_id,
            configured_index: resolvedCase.configured_index,
          },
        });
      } catch (error: unknown) {
        state.infrastructureErrors.push(
          safeErrorMessage(error, 'Eval case event emission failed.'),
        );
      }
      const failure = failures.get(workerIndex);
      const task =
        failure === undefined
          ? startCase(run, resolvedCase, runner, signal, workerIndex)
          : Promise.resolve<SettledCase<Payload>>({
              resolvedCase,
              workerIndex,
              cancelledAtSettlement: signal.aborted,
              result: { status: 'rejected', reason: new Error(failure) },
            });
      pending.set(
        workerIndex,
        task.then((settled) => completions.push(settled)),
      );
    }
  };
  try {
    await schedule();
    while (pending.size > 0) {
      const settled = await completions.next();
      pending.delete(settled.workerIndex);
      if (batches === undefined) {
        const queue = queues.get(settled.resolvedCase.test_id);
        if (queue === undefined || queue.active < 1) {
          throw new Error('Eval test queue accounting drifted.');
        }
        queue.active -= 1;
        eligibleQueues.enqueue(queue);
      } else {
        if (settled.result.status === 'rejected')
          failures.set(
            settled.workerIndex,
            safeErrorMessage(settled.result.reason, 'The worker case failed.'),
          );
        else if (settled.result.value.lifecycle_error !== undefined)
          failures.set(settled.workerIndex, settled.result.value.lifecycle_error);
      }
      // Refill before awaiting the ordered persistence sink. The completion queue remains bounded
      // by the slot count, including settled tasks whose results have not been consumed yet.
      await schedule();
      await recordSettledCase(run, settled, persistence, emit, state);
    }
  } finally {
    await Promise.all(pending.values());
  }
  return state;
};

export { executeCases };
