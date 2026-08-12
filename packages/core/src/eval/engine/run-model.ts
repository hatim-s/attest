import {
  CLI_EVENT_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  type EvalEvent,
  type EvalFinalResultData,
  type EvalRunSummary,
} from '@attest/contracts';

import type {
  EvalExecutionResult,
  EvalTerminalFailureFactory,
  ExecuteEvalOptions,
  ImmutableEvalRun,
  ResolvedEvalPlan,
} from '../types.js';

const EMPTY_SUMMARY: EvalRunSummary = {
  total_cases: 0,
  passed_cases: 0,
  failed_cases: 0,
  error_cases: 0,
  metric_error_count: 0,
};

/** Recursively freezes cloned JSON metadata so adapters cannot mutate the run snapshot. */
const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

/** Produces an owned immutable copy of resolver-supplied eval-run metadata. */
const freezeEvalRun = (run: ResolvedEvalPlan['run']): ImmutableEvalRun =>
  deepFreeze(structuredClone(run));

/** Converts hostile thrown values to bounded, non-sensitive infrastructure diagnostics. */
const safeErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  return message.length <= 512 ? message : `${message.slice(0, 509)}...`;
};

/** Builds the shared failure envelope without leaking raw adapter evidence. */
const defaultTerminalFailure: EvalTerminalFailureFactory = (code, message) => ({
  exit_code: code === 'cancelled' ? 130 : 4,
  result: {
    schema: CLI_RESULT_SCHEMA_ID,
    ok: false,
    command: 'eval.run',
    error: { code, message, retryable: true },
  },
});

/** Builds the completed pass/fail envelope shared by JSON and the final JSONL event. */
const completedResult = (run: ImmutableEvalRun, summary: EvalRunSummary): EvalFinalResultData => {
  const verdict = summary.failed_cases === 0 ? 'pass' : 'fail';
  const sharedResult = {
    schema: CLI_RESULT_SCHEMA_ID,
    ok: true as const,
    command: 'eval.run' as const,
    project_hash_before: run.snapshot.project_hash,
    project_hash_after: run.snapshot.project_hash,
    warnings: [],
  };
  const payload = {
    run_id: run.run_id,
    snapshot_hash: run.snapshot_hash,
    status: 'completed' as const,
    summary,
    ...(run.effective_command.resolved.baseline_run_id === undefined
      ? {}
      : { baseline_run_id: run.effective_command.resolved.baseline_run_id }),
    ...(run.effective_command.resolved.junit_path === undefined
      ? {}
      : { junit_path: run.effective_command.resolved.junit_path }),
  };
  return verdict === 'pass'
    ? { exit_code: 0, result: { ...sharedResult, result: { ...payload, verdict: 'pass' } } }
    : { exit_code: 1, result: { ...sharedResult, result: { ...payload, verdict: 'fail' } } };
};

/** Creates a contract-shaped result-only response for failures before orchestration starts. */
const preOrchestrationFailure = async <Payload, BaselineDiff>(
  run: ImmutableEvalRun,
  now: () => string,
  finalResult: EvalFinalResultData,
  onEvent: ExecuteEvalOptions['onEvent'],
): Promise<EvalExecutionResult<Payload, BaselineDiff>> => {
  const event: EvalEvent = {
    schema: CLI_EVENT_SCHEMA_ID,
    sequence: 0,
    time: now(),
    event: 'result',
    data: finalResult,
  };
  try {
    await onEvent?.(event);
  } catch {
    // The primary failure remains authoritative when its one result-event sink also fails.
  }
  return {
    run,
    status: finalResult.exit_code === 130 ? 'cancelled' : 'failed',
    exit_code: finalResult.exit_code as 4 | 130,
    summary: EMPTY_SUMMARY,
    cases: [],
    events: [event],
    final_result: finalResult,
    can_release_cancellation_ownership: true,
  };
};

export {
  completedResult,
  defaultTerminalFailure,
  freezeEvalRun,
  preOrchestrationFailure,
  safeErrorMessage,
};
