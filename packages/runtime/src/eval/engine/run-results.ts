import {
  CLI_EVENT_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  type EvalEvent,
  type EvalFinalResultData,
  type EvalRun,
  type EvalRunSummary,
} from '@attest/contracts';

import { summarizeEvalCases } from '../normalization.js';
import type {
  EvalExecutionResult,
  EvalRunStatus,
  EvalTerminalFailureFactory,
  ExecuteEvalOptions,
} from '../types.js';

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
const completedResult = (run: Readonly<EvalRun>, summary: EvalRunSummary): EvalFinalResultData => {
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
    // The result is validated as JSON, which rejects keys holding undefined, so absent fields are omitted.
    ...(run.snapshot.selection === undefined ? {} : { selection: run.snapshot.selection }),
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

/** Picks the terminal result envelope for a finished run. */
const terminalResultFor = (
  run: Readonly<EvalRun>,
  summary: EvalRunSummary,
  outcome: {
    status: EvalRunStatus;
    timedOut: boolean;
    terminalFailure: EvalTerminalFailureFactory;
  },
): EvalFinalResultData => {
  if (outcome.status === 'completed') {
    return completedResult(run, summary);
  }
  if (outcome.status === 'cancelled') {
    return outcome.terminalFailure('cancelled', 'Eval run was cancelled.');
  }
  if (outcome.timedOut) {
    return outcome.terminalFailure('run_failed', 'Eval run deadline exceeded.');
  }
  return outcome.terminalFailure(
    'run_failed',
    'Eval run encountered an invocation, metric, persistence, or artifact error.',
  );
};

/** Creates a contract-shaped result-only response for failures before orchestration starts. */
const preOrchestrationFailure = async <Payload, BaselineDiff>(
  run: Readonly<EvalRun>,
  failure: {
    time: string;
    status: 'cancelled' | 'failed';
    finalResult: EvalFinalResultData;
    onEvent: ExecuteEvalOptions['onEvent'];
  },
): Promise<EvalExecutionResult<Payload, BaselineDiff>> => {
  const event: EvalEvent = {
    schema: CLI_EVENT_SCHEMA_ID,
    sequence: 0,
    time: failure.time,
    event: 'result',
    data: failure.finalResult,
  };
  try {
    await failure.onEvent?.(event);
  } catch {
    // The primary failure remains authoritative when its one result-event sink also fails.
  }
  return {
    run,
    status: failure.status,
    exit_code: failure.finalResult.exit_code,
    summary: summarizeEvalCases([]),
    cases: [],
    events: [event],
    final_result: failure.finalResult,
    can_release_cancellation_ownership: true,
  };
};

export { defaultTerminalFailure, preOrchestrationFailure, terminalResultFor };
