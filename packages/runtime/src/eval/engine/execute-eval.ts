import type { EvalFinalResultData, EvalRun } from '@attest/contracts';

import { isCleanupUncertain, safeErrorMessage } from '../errors.js';
import { withEvalHooks } from '../hooks.js';
import { createEvalJUnitPayload } from '../junit.js';
import { summarizeEvalCases } from '../normalization.js';
import type {
  EvalCaseRecord,
  EvalCaseRunner,
  EvalExecutionResult,
  EvalJUnitPayload,
  EvalPersistenceAdapter,
  EvalRunStatus,
  ExecuteEvalOptions,
  ResolvedEvalPlan,
} from '../types.js';
import { createEventCollector, MAXIMUM_EVENTS } from './event-collector.js';
import { executeCases } from './execute-cases.js';
import { expectedEventCount, validateResolvedPlan } from './plan-validation.js';
import {
  defaultTerminalFailure,
  preOrchestrationFailure,
  terminalResultFor,
} from './run-results.js';

/** Reads abort state through a call so earlier narrowing of `signal.aborted` does not stick. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Facts gathered while a run executes that decide its terminal status. */
type RunStatusInputs = {
  callerCancelled: boolean;
  timedOut: boolean;
  hasCancelledCase: boolean;
  hasCaseError: boolean;
  casePersistenceConfirmed: boolean;
  cleanupConfirmed: boolean;
  infrastructureErrorCount: number;
};

/**
 * Lost case records or unconfirmed cleanup always fail a run: cancellation is not successful while
 * a runner may still own live child processes. Caller cancellation outranks other failures.
 */
const classifyRunStatus = (inputs: RunStatusInputs): EvalRunStatus => {
  if (!inputs.casePersistenceConfirmed || !inputs.cleanupConfirmed) return 'failed';
  if (inputs.callerCancelled || (!inputs.timedOut && inputs.hasCancelledCase)) return 'cancelled';
  if (inputs.timedOut || inputs.hasCaseError || inputs.infrastructureErrorCount > 0) {
    return 'failed';
  }
  return 'completed';
};

/** Publishes the optional baseline diff and JUnit artifact of a completed run. */
const publishArtifacts = async <Payload, BaselineDiff>(
  run: Readonly<EvalRun>,
  records: readonly EvalCaseRecord<Payload>[],
  options: ExecuteEvalOptions<BaselineDiff, Payload>,
  infrastructureErrors: string[],
): Promise<{ baselineDiff?: BaselineDiff; junit?: EvalJUnitPayload }> => {
  const published: { baselineDiff?: BaselineDiff; junit?: EvalJUnitPayload } = {};
  const baselineRunId = run.effective_command.resolved.baseline_run_id;
  if (baselineRunId !== undefined) {
    if (options.baseline === undefined) {
      infrastructureErrors.push('Baseline adapter is not configured.');
    } else {
      try {
        published.baselineDiff = await options.baseline.diffRuns({
          baselineRunId,
          candidateRunId: run.run_id,
        });
      } catch (error: unknown) {
        infrastructureErrors.push(safeErrorMessage(error, 'Baseline diff failed.'));
      }
    }
  }

  const junitPath = run.effective_command.resolved.junit_path;
  if (junitPath === undefined || infrastructureErrors.length > 0) {
    return published;
  }
  if (options.artifacts === undefined) {
    infrastructureErrors.push('JUnit artifact writer is not configured.');
    return published;
  }
  try {
    const junit = createEvalJUnitPayload(
      run.run_id,
      records.map(({ normalized }) => normalized),
    );
    await options.artifacts.writeJUnitAtomically(junitPath, junit);
    published.junit = junit;
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'JUnit publication failed.'));
  }
  return published;
};

/** Executes a resolved eval plan through persistence, artifacts, and one bounded event stream. */
const executeResolvedEvalPlan = async <Payload, BaselineDiff = unknown>(
  plan: ResolvedEvalPlan<Payload>,
  caseRunner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  options: ExecuteEvalOptions<BaselineDiff, Payload> = {},
): Promise<EvalExecutionResult<Payload, BaselineDiff>> => {
  const run: Readonly<EvalRun> = plan.run;
  const runner = withEvalHooks(run, caseRunner, options.hooks ?? [], options.isolation);
  const now = options.now ?? (() => new Date().toISOString());
  const terminalFailure = options.terminalFailure ?? defaultTerminalFailure;
  const planError =
    validateResolvedPlan(plan, run) ??
    (expectedEventCount(plan) > MAXIMUM_EVENTS
      ? 'Resolved eval plan exceeds the configured event count cap.'
      : undefined);
  if (planError !== undefined) {
    return preOrchestrationFailure(run, {
      time: now(),
      status: 'failed',
      finalResult: terminalFailure('run_failed', planError),
      onEvent: options.onEvent,
    });
  }
  if (isAborted(options.signal)) {
    return preOrchestrationFailure(run, {
      time: now(),
      status: 'cancelled',
      finalResult: terminalFailure(
        'cancelled',
        'Eval run was cancelled before orchestration started.',
      ),
      onEvent: options.onEvent,
    });
  }

  try {
    await persistence.createRun(run);
  } catch (error: unknown) {
    return preOrchestrationFailure(run, {
      time: now(),
      status: 'failed',
      finalResult: terminalFailure(
        'run_failed',
        safeErrorMessage(error, 'Eval run creation failed.'),
      ),
      onEvent: options.onEvent,
    });
  }

  const collector = createEventCollector(now, options.onEvent);
  try {
    await collector.emit({
      event: 'run_started',
      data: {
        run_id: run.run_id,
        snapshot_hash: run.snapshot_hash,
        total_cases: plan.cases.length,
        ...(run.snapshot.selection === undefined ? {} : { selection: run.snapshot.selection }),
        concurrency: run.effective_command.resolved.concurrency,
        timeout_ms: run.effective_command.resolved.timeout_ms,
      },
    });
  } catch (error: unknown) {
    const failure = await preOrchestrationFailure<Payload, BaselineDiff>(run, {
      time: now(),
      status: 'failed',
      finalResult: terminalFailure(
        'run_failed',
        safeErrorMessage(error, 'Eval start event emission failed.'),
      ),
      onEvent: options.onEvent,
    });
    try {
      await persistence.finalizeRun(run.run_id, 'failed', failure.summary);
    } catch {
      // The row may still be running, so its owner must retain cancellation ownership.
      failure.can_release_cancellation_ownership = false;
    }
    return failure;
  }

  // Caller cancellation and the run deadline both abort case work; only the deadline sets timedOut.
  const deadline = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    deadline.abort(new Error('Eval run deadline exceeded.'));
  }, run.effective_command.resolved.timeout_ms);
  const runSignal =
    options.signal === undefined
      ? deadline.signal
      : AbortSignal.any([options.signal, deadline.signal]);
  let callerCancelled = false;

  let records: EvalCaseRecord<Payload>[] = [];
  const infrastructureErrors: string[] = [];
  let cleanupConfirmed = true;
  let casePersistenceConfirmed = true;

  try {
    await runner.beforeRun?.(run.run_id, runSignal);
    const execution = await executeCases(
      run,
      plan.cases,
      runner,
      persistence,
      runSignal,
      collector.emit,
    );
    records = execution.records;
    infrastructureErrors.push(...execution.infrastructureErrors);
    casePersistenceConfirmed = execution.persistenceConfirmed;
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'Eval orchestration failed.'));
  } finally {
    clearTimeout(timeout);
    callerCancelled = isAborted(options.signal);
    try {
      await runner.cleanup?.(run.run_id);
    } catch (error: unknown) {
      cleanupConfirmed = false;
      infrastructureErrors.push(safeErrorMessage(error, 'Eval runner cleanup failed.'));
    }
  }

  const normalizedCases = records.map(({ normalized }) => normalized);
  const summary = summarizeEvalCases(normalizedCases);
  const statusInputs = (): RunStatusInputs => ({
    callerCancelled,
    timedOut,
    hasCancelledCase: normalizedCases.some(({ outcome }) => outcome === 'cancelled'),
    hasCaseError: normalizedCases.some(({ verdict }) => verdict === 'error'),
    casePersistenceConfirmed,
    cleanupConfirmed,
    infrastructureErrorCount: infrastructureErrors.length,
  });

  const published =
    classifyRunStatus(statusInputs()) === 'completed'
      ? await publishArtifacts(run, records, options, infrastructureErrors)
      : {};
  const sinkFailure = collector.sinkFailure();
  if (sinkFailure !== undefined) infrastructureErrors.push(sinkFailure.message);
  let status = classifyRunStatus(statusInputs());

  /** Reconciles the stored run to failed after a later step broke; reports whether that held. */
  const finalizeAsFailed = async (fallback: string): Promise<boolean> => {
    status = 'failed';
    try {
      await persistence.finalizeRun(run.run_id, 'failed', summary);
      return true;
    } catch (error: unknown) {
      infrastructureErrors.push(safeErrorMessage(error, fallback));
      return false;
    }
  };

  let finalizationConfirmed = true;
  try {
    await persistence.finalizeRun(run.run_id, status, summary);
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'Eval run finalization failed.'));
    finalizationConfirmed = await finalizeAsFailed('Eval run failure reconciliation failed.');
  }

  try {
    await runner.afterRun?.(run.run_id, status, summary);
  } catch (error: unknown) {
    if (isCleanupUncertain(error)) cleanupConfirmed = false;
    infrastructureErrors.push(safeErrorMessage(error, 'The after_run hook failed.'));
    finalizationConfirmed = await finalizeAsFailed('Eval hook failure finalization failed.');
  }

  let finalResult: EvalFinalResultData = terminalResultFor(run, summary, {
    status,
    timedOut,
    terminalFailure,
  });
  try {
    await collector.emit({ event: 'run_completed', data: { run_id: run.run_id, status, summary } });
    await collector.emit({ event: 'result', data: finalResult });
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'Eval terminal event emission failed.'));
    finalResult = terminalFailure('run_failed', 'Eval terminal event emission failed.');
    finalizationConfirmed = await finalizeAsFailed('Eval terminal failure reconciliation failed.');
    if (collector.events.at(-1)?.event === 'run_completed') collector.events.pop();
    try {
      await collector.emit({
        event: 'run_completed',
        data: { run_id: run.run_id, status, summary },
      });
      await collector.emit({ event: 'result', data: finalResult });
    } catch {
      // The bounded result object below remains authoritative when the event cap is exhausted.
    }
  }

  return {
    run,
    status,
    exit_code: finalResult.exit_code,
    summary,
    cases: records,
    events: collector.events,
    final_result: finalResult,
    can_release_cancellation_ownership:
      cleanupConfirmed && finalizationConfirmed && casePersistenceConfirmed,
    baseline_diff: published.baselineDiff,
    junit: published.junit,
  };
};

export { executeResolvedEvalPlan };
