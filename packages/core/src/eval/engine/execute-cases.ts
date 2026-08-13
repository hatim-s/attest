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
  result:
    | { status: 'fulfilled'; value: Awaited<ReturnType<EvalCaseRunner<Payload>['executeCase']>> }
    | { status: 'rejected'; reason: unknown };
};

/** Runs the bounded case pool, persists each result, and emits exact completion order. */
const executeCases = async <Payload>(
  run: ImmutableEvalRun,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: EventCollector['emit'],
): Promise<{ records: EvalCaseRecord<Payload>[]; infrastructureErrors: string[] }> => {
  const concurrency = run.effective_command.resolved.concurrency;
  const pending = new Map<number, Promise<SettledCase<Payload>>>();
  const activeByTest = new Map<string, number>();
  const records: EvalCaseRecord<Payload>[] = [];
  const infrastructureErrors: string[] = [];
  let nextIndex = 0;

  const schedule = async (): Promise<void> => {
    while (pending.size < concurrency && nextIndex < cases.length) {
      const resolvedCase = cases[nextIndex] as ResolvedEvalCase<Payload>;
      const testConcurrency = resolvedCase.test_concurrency ?? concurrency;
      const activeForTest = activeByTest.get(resolvedCase.test_id) ?? 0;
      // Case-start order is contractual, so a saturated test pauses later configured cases.
      if (activeForTest >= testConcurrency) break;
      nextIndex += 1;
      await emit({
        event: 'case_started',
        data: {
          run_id: run.run_id,
          test_id: resolvedCase.test_id,
          case_id: resolvedCase.case_id,
          configured_index: resolvedCase.configured_index,
        },
      });
      const task = runner.executeCase(run.run_id, resolvedCase, signal).then(
        (value): SettledCase<Payload> => ({
          resolvedCase,
          result: { status: 'fulfilled', value },
        }),
        (reason: unknown): SettledCase<Payload> => ({
          resolvedCase,
          result: { status: 'rejected', reason },
        }),
      );
      pending.set(resolvedCase.configured_index, task);
      activeByTest.set(resolvedCase.test_id, activeForTest + 1);
    }
  };

  await schedule();
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.resolvedCase.configured_index);
    const activeForTest = activeByTest.get(settled.resolvedCase.test_id) ?? 1;
    if (activeForTest <= 1) activeByTest.delete(settled.resolvedCase.test_id);
    else activeByTest.set(settled.resolvedCase.test_id, activeForTest - 1);
    const completionIndex = records.length;
    let record: EvalCaseRecord<Payload>;

    if (
      settled.result.status === 'fulfilled' &&
      settled.result.value.execution.caseId === settled.resolvedCase.case_id
    ) {
      const { execution, metrics } = settled.result.value;
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
      infrastructureErrors.push(error.message);
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

    records.push(record);
    try {
      await persistence.recordCase(run.run_id, record);
    } catch (error: unknown) {
      infrastructureErrors.push(safeErrorMessage(error, 'Eval case persistence failed.'));
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
    await schedule();
  }

  return { records, infrastructureErrors };
};

export { executeCases };
