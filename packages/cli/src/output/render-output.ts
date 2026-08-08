import { diffToJson, type RunDiff, type RunRecord } from '@attest/core';

import type { LegacyRunExecutionResult } from '../run/run-configuration.js';

/** Renders a compact terminal summary whose identifiers make follow-up diff commands copyable. */
const renderRunSummary = (result: LegacyRunExecutionResult): string => {
  const summary = result.run.summary;
  if (summary === undefined) {
    return `Run ${result.run.id} completed without a persisted summary.`;
  }

  return [
    `Run ${result.run.id}`,
    `  cases: ${summary.totalCases}`,
    `  passed: ${summary.passedCases}`,
    `  failed: ${summary.failedCases}`,
    `  errors: ${summary.errorCases}`,
    `  metric errors: ${summary.metricErrorCount}`,
    `  store: ${result.storePath}`,
  ].join('\n');
};

/** Serializes a run result without leaking the internal store handle or transient execution state. */
const renderRunJson = (result: LegacyRunExecutionResult): string =>
  JSON.stringify({ run: result.run, cases: result.cases, diff: result.diff ?? null });

/** Renders transition totals and pass-rate movement for human CLI diff output. */
const renderDiffSummary = (diff: RunDiff): string => {
  const { summary } = diff;
  return [
    `Diff ${summary.baseRunId} → ${summary.candidateRunId}`,
    `  pass rate: ${(summary.basePassRate * 100).toFixed(1)}% → ${(summary.candidatePassRate * 100).toFixed(1)}%`,
    `  regressed: ${summary.counts.regressed}`,
    `  fixed: ${summary.counts.fixed}`,
    `  added: ${summary.counts.added}`,
    `  removed: ${summary.counts.removed}`,
    `  flaky suspects: ${summary.flakySuspectCount}`,
  ].join('\n');
};

/** Returns a non-zero result when a completed evaluation contains failed or errored cases. */
const runExitCode = (run: RunRecord): 0 | 1 => {
  const summary = run.summary;
  return summary !== undefined && summary.failedCases === 0 && summary.errorCases === 0 ? 0 : 1;
};

export { diffToJson, renderDiffSummary, renderRunJson, renderRunSummary, runExitCode };
