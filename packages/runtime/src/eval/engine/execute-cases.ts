import type { EvalRun } from '@attest/contracts';

import { safeErrorMessage } from '../errors.js';
import { normalizeCaseResult, normalizeInfrastructureFailure } from '../normalization.js';
import type {
  EvalCaseRecord,
  EvalCaseRunner,
  EvalCaseRunnerResult,
  EvalPersistenceAdapter,
  ResolvedEvalCase,
} from '../types.js';
import { createCaseScheduler } from './case-scheduler.js';
import type { EventCollector } from './event-collector.js';

type SettledCase<Payload> = {
  resolvedCase: ResolvedEvalCase<Payload>;
  workerIndex: number;
  cancelledAtSettlement: boolean;
  result:
    { status: 'fulfilled'; value: EvalCaseRunnerResult } | { status: 'rejected'; reason: unknown };
};

type CaseExecutionState<Payload> = {
  records: EvalCaseRecord<Payload>[];
  infrastructureErrors: string[];
  persistenceConfirmed: boolean;
};

/** Everything one case task needs; the worker identity stays stable for the whole case. */
type CaseTask<Payload> = {
  run: Readonly<EvalRun>;
  runner: EvalCaseRunner<Payload>;
  signal: AbortSignal;
};

/** Runs one case and never rejects, so a runner throw becomes settled evidence. */
const startCase = async <Payload>(
  task: CaseTask<Payload>,
  resolvedCase: ResolvedEvalCase<Payload>,
  workerIndex: number,
): Promise<SettledCase<Payload>> => {
  try {
    task.signal.throwIfAborted();
    const value = await task.runner.executeCase(task.run.run_id, resolvedCase, task.signal, {
      workerIndex,
    });
    return {
      resolvedCase,
      workerIndex,
      cancelledAtSettlement: task.signal.aborted,
      result: { status: 'fulfilled', value },
    };
  } catch (reason: unknown) {
    return {
      resolvedCase,
      workerIndex,
      cancelledAtSettlement: task.signal.aborted,
      result: { status: 'rejected', reason },
    };
  }
};

/** Builds the stored record for one settled case, turning runner failures into infrastructure errors. */
const toCaseRecord = <Payload>(
  run: Readonly<EvalRun>,
  settled: SettledCase<Payload>,
  completionIndex: number,
  state: CaseExecutionState<Payload>,
): EvalCaseRecord<Payload> => {
  const { resolvedCase, result } = settled;
  if (result.status === 'fulfilled' && result.value.execution.caseId === resolvedCase.case_id) {
    const { execution, metrics } = result.value;
    if (execution.diagnostics.lifecycleError !== undefined) {
      state.infrastructureErrors.push(execution.diagnostics.lifecycleError);
    }
    return {
      kind: 'executed',
      resolved_case: resolvedCase,
      execution,
      metrics,
      normalized: normalizeCaseResult(resolvedCase, execution, metrics, completionIndex),
    };
  }

  const reason =
    result.status === 'rejected'
      ? result.reason
      : new Error(
          `Runner case id ${result.value.execution.caseId} does not match ${resolvedCase.case_id}.`,
        );
  const message = safeErrorMessage(reason, 'Eval case runner failed.');
  state.infrastructureErrors.push(message);
  return {
    kind: 'infrastructure_error',
    resolved_case: resolvedCase,
    error: { code: 'eval_case_runner_failed', message },
    normalized: normalizeInfrastructureFailure(resolvedCase, {
      completionIndex,
      cancelled: settled.cancelledAtSettlement,
      startedAt: run.created_at,
    }),
  };
};

/** Normalizes, persists, and emits one settled case in observed completion order. */
const recordSettledCase = async <Payload>(
  run: Readonly<EvalRun>,
  settled: SettledCase<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  emit: EventCollector['emit'],
  state: CaseExecutionState<Payload>,
): Promise<void> => {
  const record = toCaseRecord(run, settled, state.records.length, state);
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

/**
 * In worker mode a failed case leaves its worker directory in an unknown state, so the rest of that
 * worker's batch is recorded as failed instead of running on top of it.
 */
const workerFailure = <Payload>(settled: SettledCase<Payload>): string | undefined => {
  if (settled.result.status === 'rejected') {
    return safeErrorMessage(settled.result.reason, 'The worker case failed.');
  }
  return settled.result.value.execution.diagnostics.lifecycleError;
};

/** Admits eligible cases into bounded slots and drains every admitted task before returning. */
const executeCases = async <Payload>(
  run: Readonly<EvalRun>,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
): Promise<CaseExecutionState<Payload>> => {
  const task: CaseTask<Payload> = { run, runner, signal };
  const concurrency = Math.min(run.effective_command.resolved.concurrency, cases.length);
  const workerCount = run.effective_command.resolved.execution?.workers?.count;
  const scheduler = createCaseScheduler(cases, { concurrency, workerCount });
  const failedWorkers = new Map<number, string>();
  const pending = new Map<number, Promise<SettledCase<Payload>>>();
  const completions: SettledCase<Payload>[] = [];
  const state: CaseExecutionState<Payload> = {
    records: [],
    infrastructureErrors: [],
    persistenceConfirmed: true,
  };

  const schedule = async (): Promise<void> => {
    for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
      if (pending.has(workerIndex)) continue;
      const resolvedCase = scheduler.take(workerIndex);
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
      const failure = failedWorkers.get(workerIndex);
      pending.set(
        workerIndex,
        (failure === undefined
          ? startCase(task, resolvedCase, workerIndex)
          : Promise.resolve<SettledCase<Payload>>({
              resolvedCase,
              workerIndex,
              cancelledAtSettlement: signal.aborted,
              result: { status: 'rejected', reason: new Error(failure) },
            })
        ).then((settled) => {
          completions.push(settled);
          return settled;
        }),
      );
    }
  };

  try {
    await schedule();
    while (pending.size > 0) {
      // Several cases can settle while persistence waits. Capture their order at settlement;
      // Promise.race alone picks map order when all its inputs have already resolved.
      if (completions.length === 0) await Promise.race(pending.values());
      const settled = completions.shift()!;
      pending.delete(settled.workerIndex);
      scheduler.release(settled.resolvedCase);
      const failure = workerCount === undefined ? undefined : workerFailure(settled);
      if (failure !== undefined) failedWorkers.set(settled.workerIndex, failure);
      // Refill before awaiting the ordered persistence sink so slots never idle on persistence.
      await schedule();
      await recordSettledCase(run, settled, persistence, emit, state);
    }
  } finally {
    await Promise.all(pending.values());
  }
  return state;
};

export { executeCases };
