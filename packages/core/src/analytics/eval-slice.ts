import type { SliceTotals, EvalSlice, EvalPage } from '../records/dashboard-schemas.js';
import type { RunRecord, CaseSummary, RunSummary } from '../store/types.js';

/** Creates fresh counters for one selected eval, including a known empty selection. */
const emptySliceTotals = (planned: number | null): SliceTotals => ({
  planned,
  recorded: 0,
  passed: 0,
  failed: 0,
  errored: 0,
  skipped: 0,
  metricErrors: 0,
  scored: 0,
  scoreSum: 0,
});

/** Fresh empty run summary shared by projection consumers. */
const emptyRunSummary = (): RunSummary => ({
  totalCases: 0,
  passedCases: 0,
  failedCases: 0,
  errorCases: 0,
  metricErrorCount: 0,
});

/** Run errors include skipped cases; eval coverage retains the distinction. */
const addSliceToRunSummary = (summary: RunSummary, totals: SliceTotals): RunSummary => ({
  totalCases: summary.totalCases + totals.recorded,
  passedCases: summary.passedCases + totals.passed,
  failedCases: summary.failedCases + totals.failed,
  errorCases: summary.errorCases + totals.errored + totals.skipped,
  metricErrorCount: summary.metricErrorCount + totals.metricErrors,
});

/** Adds one case projection using the same rule for snapshots, migration and live writes. */
const addCaseToTotals = (totals: SliceTotals, summary: CaseSummary): SliceTotals => ({
  ...totals,
  recorded: totals.recorded + 1,
  passed: totals.passed + Number(summary.verdict === 'pass'),
  failed: totals.failed + Number(summary.verdict === 'fail'),
  errored: totals.errored + Number(summary.verdict === 'error' && summary.outcome !== 'cancelled'),
  skipped: totals.skipped + Number(summary.outcome === 'cancelled'),
  metricErrors: totals.metricErrors + summary.metricCounts.errors,
  scored: totals.scored + Number(summary.score !== undefined),
  scoreSum: totals.scoreSum + (summary.score ?? 0),
});

/** Derives slice completeness independently of the enclosing multi-eval run's verdict. */
const toEvalSlice = (
  totals: SliceTotals,
  run: Pick<RunRecord, 'id' | 'createdAt' | 'finishedAt' | 'status' | 'gitBranch' | 'gitSha'>,
  suiteName: string,
): EvalSlice => {
  const notRun = totals.planned === null ? null : totals.planned - totals.recorded;

  if (notRun !== null && notRun < 0)
    throw new RangeError('Recorded cases exceed the planned selection.');

  if (totals.recorded !== totals.passed + totals.failed + totals.errored + totals.skipped)
    throw new RangeError('Slice counts disagree.');

  const complete =
    run.status !== 'running' &&
    totals.recorded > 0 &&
    totals.errored === 0 &&
    totals.skipped === 0 &&
    notRun === 0;

  const common = {
    runId: run.id,
    suiteName,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    runStatus: run.status,
    gitBranch: run.gitBranch ?? null,
    gitSha: run.gitSha ?? null,
    counts: { ...totals, notRun },
    meanScore: totals.scored === 0 ? null : totals.scoreSum / totals.scored,
  };

  return complete
    ? { ...common, state: 'complete', passRate: totals.passed / totals.recorded }
    : { ...common, state: run.status === 'running' ? 'running' : 'incomplete', passRate: null };
};

/** Reuses slice semantics for an already loaded static report, without store dependencies. */
const sliceFromCaseSummaries = (
  run: RunRecord,
  summaries: readonly CaseSummary[],
  suiteName: string,
  planned: number | null,
): EvalSlice =>
  toEvalSlice(
    summaries
      .filter((row) => row.suiteName === suiteName)
      .reduce(addCaseToTotals, emptySliceTotals(planned)),
    run,
    suiteName,
  );

/** Keeps a running slice separate from the last terminal verdict used by overview badges. */
const summarizeEvalSlices = (
  latest: EvalSlice,
  latestComplete: EvalSlice | null,
  latestIncomplete: EvalSlice | null,
): EvalPage['items'][number] => {
  const terminal =
    [latestComplete, latestIncomplete]
      .filter((slice) => slice !== null)
      .sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId),
      )[0] ?? null;

  return {
    suiteName: latest.suiteName,
    latest,
    latestComplete,
    latestTerminal: terminal,
    failing:
      terminal === null || terminal.counts.planned === null
        ? null
        : terminal.state !== 'complete' || terminal.counts.failed > 0,
  };
};

export {
  emptyRunSummary,
  addSliceToRunSummary,
  summarizeEvalSlices,
  emptySliceTotals,
  addCaseToTotals,
  toEvalSlice,
  sliceFromCaseSummaries,
};
