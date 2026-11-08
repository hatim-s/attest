import { useDashboardSource } from '../../api/api-client-context.js';
import { CaseStrip, EXACT_STRIP_LIMIT } from '../../components/meters/case-strip.js';
import { formatCount, formatStarted, shortRunId } from '../../lib/format.js';
import { useTargetHref } from '../frame/use-target-href.js';
import type { CaseCell } from './case-standing.js';

/** One recorded result of the case. Runs without a row for the case have no mark. */
type HistoryMark = { runId: string; createdAt: string; cell: CaseCell };

type CaseHistoryStripProps = {
  projectKey: string;
  suiteName: string;
  caseId: string;
  /** Newest first, as every history read returns them. */
  marks: readonly HistoryMark[];
};

/**
 * A case's results oldest first, so the last mark is its latest result. Each mark opens the case
 * in that run. The strip draws at most its newest forty marks.
 */
const CaseHistoryStrip = ({ projectKey, suiteName, caseId, marks }: CaseHistoryStripProps) => {
  const source = useDashboardSource();
  const hrefFor = useTargetHref();
  const shown = marks.slice(0, EXACT_STRIP_LIMIT).reverse();

  return (
    <CaseStrip
      label={`${caseId} across ${formatCount(shown.length, 'run')}, oldest first`}
      records={shown.map((mark) => ({
        id: mark.runId,
        label: `Run ${shortRunId(mark.runId)}, ${formatStarted(mark.createdAt)}`,
        verdict: mark.cell,
        href: hrefFor({
          kind: 'run-case',
          sourceId: source.id,
          projectKey,
          evalId: suiteName,
          runId: mark.runId,
          caseId,
        }),
      }))}
    />
  );
};

export { CaseHistoryStrip, type HistoryMark };
