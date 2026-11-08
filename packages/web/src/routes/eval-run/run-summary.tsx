import type { CaseSummary, EvalRunPage, EvalSlice } from '@attest/core/records';
import { CaseStrip } from '../../components/meters/case-strip.js';
import { shortRunId } from '../../lib/format.js';
import { useTargetHref } from '../frame/use-target-href.js';
import { useDashboardSource } from '../../api/api-client-context.js';
import {
  runChange,
  runCounts,
  runHeadline,
  type SummaryPart,
  type RunChange,
} from './run-verdict.js';

type RunSummaryProps = {
  projectKey: string;
  slice: EvalSlice;
  /** This eval's slices before the run, newest first; undefined while they load. */
  earlier: EvalRunPage | undefined;
  /** The run's loaded case rows, in run order. The strip draws only these. */
  cases: readonly CaseSummary[];
};

/** Why a slice without a pass rate is off the trend line. */
const PARTIAL_NOTES = {
  complete: '',
  running: ' It joins the pass-rate line when it completes.',
  incomplete: ' No pass rate, so it is not on the trend line.',
} as const satisfies Record<EvalSlice['state'], string>;

/** The change line in words; only a fewer-passed change is hot. */
const changeText = (change: RunChange): SummaryPart => {
  switch (change.kind) {
    case 'none':
      return { text: 'No earlier completed run to compare with.', hot: false };
    case 'beyond':
      return { text: `No completed run among the ${change.read} before this one.`, hot: false };
    case 'compared': {
      const previous = shortRunId(change.previousRunId);

      if (change.delta < 0)
        return { text: `${-change.delta} fewer passed than ${previous}.`, hot: true };

      if (change.delta > 0)
        return { text: `${change.delta} more passed than ${previous}.`, hot: false };

      return { text: `Same as ${previous}.`, hot: false };
    }
  }
};

/**
 * What happened in one line and one strip: "22 of 24 passed", the counts, the change against the
 * previous complete run of this eval, then a mark per loaded case.
 */
const RunSummary = ({ projectKey, slice, earlier, cases }: RunSummaryProps) => {
  const source = useDashboardSource();
  const hrefFor = useTargetHref();
  const change = earlier === undefined ? null : runChange(slice, earlier);
  const changed = change === null ? null : changeText(change);
  const counts = runCounts(slice);

  return (
    <section className="attest-verdict" aria-label="Result">
      <h2>{runHeadline(slice)}</h2>
      <p>
        {counts.length === 0 && slice.state === 'complete' ? (
          'Every case passed. '
        ) : (
          <>
            {counts.map((part, index) => (
              <span key={part.text} className={part.hot ? 'attest-hot' : undefined}>
                {index > 0 && ', '}
                {part.text}
              </span>
            ))}
            {counts.length > 0 && '. '}
          </>
        )}
        {changed !== null && (
          <span className={changed.hot ? 'attest-hot' : undefined}>{changed.text}</span>
        )}
        {PARTIAL_NOTES[slice.state]}
      </p>
      {cases.length > 0 && (
        <CaseStrip
          label={`Cases of run ${shortRunId(slice.runId)}, in run order`}
          records={cases.map((summary) => ({
            id: summary.caseId,
            label: summary.caseId,
            verdict: summary.verdict,
            href: hrefFor({
              kind: 'run-case',
              sourceId: source.id,
              projectKey,
              evalId: summary.suiteName,
              runId: slice.runId,
              caseId: summary.caseId,
            }),
          }))}
        />
      )}
    </section>
  );
};

export { RunSummary };
