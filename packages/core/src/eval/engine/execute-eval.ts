import { createEvalJUnitPayload } from '../junit.js';
import { summarizeEvalCases } from '../normalization.js';
import type {
  EvalCaseRecord,
  EvalCaseRunner,
  EvalExecutionResult,
  EvalPersistenceAdapter,
  ExecuteEvalOptions,
  ResolvedEvalPlan,
} from '../types.js';
import { createEventCollector } from './event-collector.js';
import { executeCases } from './execute-cases.js';
import { eventBytesFit, resolveEventLimits, validateResolvedPlan } from './plan-validation.js';
import {
  completedResult,
  defaultTerminalFailure,
  freezeEvalRun,
  preOrchestrationFailure,
  safeErrorMessage,
} from './run-model.js';

/** Executes a resolved eval plan through persistence, artifacts, and one bounded event stream. */
const executeResolvedEvalPlan = async <Payload, BaselineDiff = unknown>(
  plan: ResolvedEvalPlan<Payload>,
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  options: ExecuteEvalOptions<BaselineDiff> = {},
): Promise<EvalExecutionResult<Payload, BaselineDiff>> => {
  const run = freezeEvalRun(plan.run);
  const now = options.now ?? (() => new Date().toISOString());
  const limits = resolveEventLimits(options);
  const terminalFailure = options.terminalFailure ?? defaultTerminalFailure;
  const expectedEventCount = plan.cases.length * 2 + 3;
  const planError = validateResolvedPlan(plan, run);
  const eventLimitExceeded =
    expectedEventCount > limits.max_events || !eventBytesFit(plan, run, limits, terminalFailure);
  if (planError !== undefined || eventLimitExceeded) {
    return preOrchestrationFailure(
      run,
      now,
      terminalFailure(
        'run_failed',
        planError ?? 'Resolved eval plan exceeds the configured event count cap.',
      ),
      options.onEvent,
    );
  }
  if (options.signal?.aborted === true) {
    return preOrchestrationFailure(
      run,
      now,
      terminalFailure('cancelled', 'Eval run was cancelled before orchestration started.'),
      options.onEvent,
    );
  }

  try {
    await persistence.createRun(run);
  } catch (error: unknown) {
    return preOrchestrationFailure(
      run,
      now,
      terminalFailure('run_failed', safeErrorMessage(error, 'Eval run creation failed.')),
      options.onEvent,
    );
  }

  const collector = createEventCollector(now, limits, options.onEvent);
  const runController = new AbortController();
  let timedOut = false;
  let callerCancelled = false;
  const onCallerAbort = (): void => {
    callerCancelled = true;
    runController.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    runController.abort(new Error('Eval run deadline exceeded.'));
  }, run.effective_command.resolved.timeout_ms);

  let records: EvalCaseRecord<Payload>[] = [];
  const infrastructureErrors: string[] = [];
  let baselineDiff: BaselineDiff | undefined;
  let junit: ReturnType<typeof createEvalJUnitPayload> | undefined;
  let cleanupConfirmed = true;

  await collector.emit({
    event: 'run_started',
    data: {
      run_id: run.run_id,
      snapshot_hash: run.snapshot_hash,
      total_cases: plan.cases.length,
      concurrency: run.effective_command.resolved.concurrency,
      timeout_ms: run.effective_command.resolved.timeout_ms,
    },
  });

  try {
    const execution = await executeCases(
      run,
      plan.cases,
      runner,
      persistence,
      runController.signal,
      collector.emit,
    );
    records = execution.records;
    infrastructureErrors.push(...execution.infrastructureErrors);
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'Eval orchestration failed.'));
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onCallerAbort);
    try {
      await runner.cleanup?.(run.run_id);
    } catch (error: unknown) {
      cleanupConfirmed = false;
      infrastructureErrors.push(safeErrorMessage(error, 'Eval runner cleanup failed.'));
    }
  }

  const normalizedCases = records.map(({ normalized }) => normalized);
  const summary = summarizeEvalCases(normalizedCases);
  const hasCancelledCase = normalizedCases.some(({ outcome }) => outcome === 'cancelled');
  const hasCaseInfrastructureError = normalizedCases.some(({ verdict }) => verdict === 'error');
  let status: EvalExecutionResult['status'] =
    callerCancelled || (!timedOut && hasCancelledCase) ? 'cancelled' : 'completed';

  if (status === 'completed' && (timedOut || hasCaseInfrastructureError)) status = 'failed';
  if (status === 'completed' && infrastructureErrors.length === 0) {
    const baselineRunId = run.effective_command.resolved.baseline_run_id;
    if (baselineRunId !== undefined) {
      try {
        if (options.baseline === undefined) throw new Error('Baseline adapter is not configured.');
        baselineDiff = await options.baseline.diffRuns({
          baselineRunId,
          candidateRunId: run.run_id,
        });
      } catch (error: unknown) {
        infrastructureErrors.push(safeErrorMessage(error, 'Baseline diff failed.'));
      }
    }

    const junitPath = run.effective_command.resolved.junit_path;
    if (junitPath !== undefined && infrastructureErrors.length === 0) {
      try {
        if (options.artifacts === undefined) {
          throw new Error('JUnit artifact writer is not configured.');
        }
        junit = createEvalJUnitPayload(run.run_id, normalizedCases);
        await options.artifacts.writeJUnitAtomically(junitPath, junit);
      } catch (error: unknown) {
        infrastructureErrors.push(safeErrorMessage(error, 'JUnit publication failed.'));
      }
    }
  }

  const sinkFailure = collector.sinkFailure();
  if (sinkFailure !== undefined) infrastructureErrors.push(sinkFailure.message);
  // Cancellation is not successful while its runner may still own live child processes.
  if (!cleanupConfirmed) status = 'failed';
  if (status === 'completed' && infrastructureErrors.length > 0) status = 'failed';

  let finalizationConfirmed = false;
  try {
    await persistence.finalizeRun(run.run_id, status, summary);
    finalizationConfirmed = true;
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'Eval run finalization failed.'));
    status = 'failed';
    try {
      await persistence.finalizeRun(run.run_id, 'failed', summary);
      finalizationConfirmed = true;
    } catch (retryError: unknown) {
      infrastructureErrors.push(
        safeErrorMessage(retryError, 'Eval run failure reconciliation failed.'),
      );
    }
  }

  const finalResult =
    status === 'completed'
      ? completedResult(run, summary)
      : status === 'cancelled'
        ? terminalFailure('cancelled', 'Eval run was cancelled.')
        : terminalFailure(
            'run_failed',
            timedOut
              ? 'Eval run deadline exceeded.'
              : 'Eval run encountered an invocation, metric, persistence, or artifact error.',
          );

  await collector.emit({ event: 'run_completed', data: { run_id: run.run_id, status, summary } });
  await collector.emit({ event: 'result', data: finalResult });

  return {
    run,
    status,
    exit_code: finalResult.exit_code as 0 | 1 | 4 | 130,
    summary,
    cases: records,
    events: collector.events,
    final_result: finalResult,
    can_release_cancellation_ownership: cleanupConfirmed && finalizationConfirmed,
    ...(baselineDiff === undefined ? {} : { baseline_diff: baselineDiff }),
    ...(junit === undefined ? {} : { junit }),
  };
};

export { executeResolvedEvalPlan };
