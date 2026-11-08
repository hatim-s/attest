import type { EvalRunPage, EvalSlice } from '@attest/core/records';

/**
 * How this run's passes compare with the previous complete slice of the same eval. `none` means
 * the eval has no earlier complete slice; `beyond` means none in the `read` slices fetched before
 * this one, with older ones left unread.
 */
type RunChange =
  | { kind: 'none' }
  | { kind: 'beyond'; read: number }
  | { kind: 'compared'; previousRunId: string; delta: number };

type SummaryPart = { text: string; hot: boolean };

/**
 * Compares a complete slice with the newest complete slice before it. `older` is this eval's page
 * of slices created before this run, newest first. A running or incomplete slice has no pass rate,
 * so it is never compared and never serves as the baseline.
 */
const runChange = (slice: EvalSlice, older: EvalRunPage): RunChange | null => {
  if (slice.state !== 'complete') return null;

  const previous = older.items.find(
    (candidate) => candidate.state === 'complete' && candidate.runId !== slice.runId,
  );

  if (previous === undefined)
    return older.nextCursor === undefined
      ? { kind: 'none' }
      : { kind: 'beyond', read: older.items.length };

  return {
    kind: 'compared',
    previousRunId: previous.runId,
    delta: slice.counts.passed - previous.counts.passed,
  };
};

/** The planned case count when the run recorded its selection, else what it recorded. */
const caseTotal = (slice: EvalSlice) => slice.counts.planned ?? slice.counts.recorded;

/**
 * The run's headline in words. Only a complete slice reports "N of M passed"; any other slice
 * says how far it got, so lifecycle never reads as a verdict.
 */
const runHeadline = (slice: EvalSlice): string => {
  const { passed, recorded, planned } = slice.counts;
  const of = planned === null ? '' : ` of ${planned}`;

  if (slice.state === 'complete') return `${passed} of ${caseTotal(slice)} passed`;

  if (slice.state === 'running') return `${recorded}${of} finished`;

  if (slice.runStatus === 'cancelled') return `Cancelled after ${recorded}${of}`;

  if (slice.runStatus === 'failed') return `Stopped after ${recorded}${of}`;

  return `${recorded}${of} recorded`;
};

/** The counts beside the headline. Failures and errors are the only hot parts. */
const runCounts = (slice: EvalSlice): SummaryPart[] => {
  const { passed, failed, errored, skipped, notRun } = slice.counts;

  return [
    { text: slice.state === 'complete' ? '' : `${passed} passed`, hot: false },
    { text: failed > 0 ? `${failed} failed` : '', hot: true },
    { text: errored > 0 ? `${errored} errored` : '', hot: true },
    { text: skipped > 0 ? `${skipped} skipped` : '', hot: false },
    {
      text:
        notRun !== null && notRun > 0
          ? `${notRun} ${slice.state === 'running' ? 'to go' : 'not run'}`
          : '',
      hot: false,
    },
  ].filter((part) => part.text !== '');
};

export { runChange, runHeadline, runCounts, type RunChange, type SummaryPart };
