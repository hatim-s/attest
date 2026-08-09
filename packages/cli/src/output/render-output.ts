import { diffToJson, type RunDiff } from '@attest/core';

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

export { diffToJson, renderDiffSummary };
