import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Queue from 'effect/Queue';
import { observe, ordinaryError, retainedCauses } from '../lifecycle.js';
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
  cause?: Cause.Cause<Error>;
  result:
    { status: 'fulfilled'; value: EvalCaseRunnerResult } | { status: 'rejected'; reason: unknown };
};

type CaseExecutionState<Payload> = {
  records: EvalCaseRecord<Payload>[];
  infrastructureErrors: string[];
  persistenceConfirmed: boolean;
  causes: Cause.Cause<Error>[];
};

/** Everything one case task needs; the worker identity stays stable for the whole case. */
type CaseTask<Payload> = {
  run: Readonly<EvalRun>;
  runner: EvalCaseRunner<Payload>;
  signal: AbortSignal;
};

/** Publishes exactly one completion after the runner's entire lifecycle settles. */
const startCase = <Payload>(
  task: CaseTask<Payload>,
  resolvedCase: ResolvedEvalCase<Payload>,
  workerIndex: number,
) =>
  Effect.gen(function* () {
    const exit = yield* observe(() =>
      task.signal.aborted
        ? Effect.fail(new Error('Eval case cancelled before admission.'))
        : task.runner.executeCase(task.run.run_id, resolvedCase, task.signal, { workerIndex }),
    );

    return {
      resolvedCase,
      workerIndex,
      cancelledAtSettlement: task.signal.aborted,
      cause: Exit.isFailure(exit) ? exit.cause : undefined,
      result: Exit.isSuccess(exit)
        ? { status: 'fulfilled' as const, value: exit.value }
        : {
            status: 'rejected' as const,
            reason: ordinaryError(exit.cause) ?? new Error('Eval case did not complete normally.'),
          },
    };
  });

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

/** Records each completion before advancing the ordered sink, retaining full callback Causes. */
const recordSettledCase = <Payload>(
  run: Readonly<EvalRun>,
  settled: SettledCase<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  emit: EventCollector['emit'],
  state: CaseExecutionState<Payload>,
) =>
  Effect.gen(function* () {
    const record = toCaseRecord(run, settled, state.records.length, state);
    state.records.push(record);

    if (settled.cause) state.causes.push(settled.cause);

    if (settled.result.status === 'fulfilled')
      state.causes.push(...retainedCauses(settled.result.value));
    const stored = yield* observe(() => persistence.recordCase(run.run_id, record));

    if (Exit.isFailure(stored)) {
      state.persistenceConfirmed = false;
      state.causes.push(stored.cause);
      state.infrastructureErrors.push(
        safeErrorMessage(ordinaryError(stored.cause), 'Eval case persistence failed.'),
      );
    }

    const emitted = yield* observe(() =>
      emit({
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
      }),
    );

    if (Exit.isFailure(emitted)) {
      state.causes.push(emitted.cause);
      state.infrastructureErrors.push(
        safeErrorMessage(ordinaryError(emitted.cause), 'Eval case event emission failed.'),
      );
    }
  });

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

/** Refills before persistence and joins every admitted case without interrupting siblings. */
const executeCases = <Payload>(
  run: Readonly<EvalRun>,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const task = { run, runner, signal };
      const concurrency = Math.min(run.effective_command.resolved.concurrency, cases.length);
      const workerCount = run.effective_command.resolved.execution?.workers?.count;
      const scheduler = createCaseScheduler(cases, { concurrency, workerCount });
      const failedWorkers = new Map<number, string>();
      const pending = new Set<number>();
      const completions = yield* Queue.unbounded<SettledCase<Payload>>();

      const state: CaseExecutionState<Payload> = {
        records: [],
        infrastructureErrors: [],
        persistenceConfirmed: true,
        causes: [],
      };

      const schedule = () =>
        Effect.gen(function* () {
          for (let workerIndex = 0; workerIndex < concurrency; workerIndex++) {
            if (pending.has(workerIndex)) continue;
            const resolvedCase = scheduler.take(workerIndex);

            if (!resolvedCase) continue;

            const emitted = yield* observe(() =>
              emit({
                event: 'case_started',
                data: {
                  run_id: run.run_id,
                  test_id: resolvedCase.test_id,
                  case_id: resolvedCase.case_id,
                  configured_index: resolvedCase.configured_index,
                },
              }),
            );

            if (Exit.isFailure(emitted)) {
              state.causes.push(emitted.cause);
              state.infrastructureErrors.push(
                safeErrorMessage(ordinaryError(emitted.cause), 'Eval case event emission failed.'),
              );
            }

            pending.add(workerIndex);
            const failure = failedWorkers.get(workerIndex);

            const operation =
              failure === undefined
                ? startCase(task, resolvedCase, workerIndex)
                : Effect.succeed<SettledCase<Payload>>({
                    resolvedCase,
                    workerIndex,
                    cancelledAtSettlement: signal.aborted,
                    result: { status: 'rejected', reason: new Error(failure) },
                  });

            yield* Effect.forkScoped(
              Effect.gen(function* () {
                const settled = yield* operation;
                yield* Queue.offer(completions, settled);
              }),
              { uninterruptible: true },
            );
          }
        });

      yield* schedule();

      while (pending.size > 0) {
        const settled = yield* Queue.take(completions);
        pending.delete(settled.workerIndex);
        scheduler.release(settled.resolvedCase);
        const failure = workerCount === undefined ? undefined : workerFailure(settled);

        if (failure !== undefined) failedWorkers.set(settled.workerIndex, failure);
        yield* schedule();
        yield* recordSettledCase(run, settled, persistence, emit, state);
      }

      return state;
    }),
  );

export { executeCases };
