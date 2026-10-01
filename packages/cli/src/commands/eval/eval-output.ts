import {
  evalFinalResultDataSchema,
  type CliExitCode,
  type EvalFinalResultData,
} from '@attest/contracts';

import type { SerializedCliFailure } from '../../errors/cli-error.js';
import { createCliFailureResult } from '../../output/cli-protocol.js';
import { evalEvent, serializeEvalEvent } from './eval-event-stream.js';

/** Wraps a failure as the final data of a failed `eval.run`. */
const failedRunResult = (failure: SerializedCliFailure): EvalFinalResultData =>
  evalFinalResultDataSchema.parse({
    exit_code: failure.exitCode,
    result: createCliFailureResult('eval.run', failure.error),
  });

/** Prints a failure as the single `result` event of a JSONL eval stream. */
const renderEvalFailureEvent = (failure: SerializedCliFailure): string =>
  serializeEvalEvent(evalEvent(0, 'result', failedRunResult(failure), () => new Date()));

/** The last human line of every eval command, naming the outcome and exit code. */
const renderEvalResultLine = (exitCode: CliExitCode, verdict?: string): string => {
  const label = verdict ?? (exitCode === 130 ? 'CANCELLED' : 'ERROR');
  return `Result: ${label} (exit ${exitCode})`;
};

/** Renders the finished run with the commands to inspect, view, and compare it. */
const renderHumanFinalResult = (data: EvalFinalResultData): string => {
  const result = data.result;
  if (!result.ok) return renderEvalResultLine(data.exit_code);
  const run = result.result;
  const selection = run.selection;
  return [
    `Run ${run.run_id}`,
    `  cases: ${run.summary.total_cases}`,
    ...(selection === undefined
      ? []
      : [
          `  selection: ${selection.selected_cases} of ${selection.total_cases} cases, ${selection.matched_cases} matched`,
          ...(selection.sample === undefined ? [] : [`  sample seed: ${selection.sample.seed}`]),
        ]),
    `  passed: ${run.summary.passed_cases}`,
    `  failed: ${run.summary.failed_cases}`,
    `  errors: ${run.summary.error_cases}`,
    `  metric errors: ${run.summary.metric_error_count}`,
    'Next:',
    `  attest report ${run.run_id}`,
    '  attest view --no-open',
    'Compare with a baseline run:',
    // A finished eval knows only its own id, so the baseline stays a placeholder.
    `  attest diff <base-run-id> ${run.run_id}`,
    renderEvalResultLine(data.exit_code, run.verdict.toUpperCase()),
  ].join('\n');
};

export { failedRunResult, renderEvalFailureEvent, renderEvalResultLine, renderHumanFinalResult };
