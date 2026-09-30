import type { RunRecord } from '../../api/types.js';
import { formatDateTime, formatPassRate } from '../../lib/format.js';

/** Describes failed cases, plus the selection size when the run covered a subset. */
const describeCaseCounts = (run: RunRecord): string => {
  const failed = `${run.summary?.failedCases ?? 0} failed`;
  const labels = run.labels;
  if (labels?.selection_total === undefined) return failed;
  if (labels.selection_selected === labels.selection_total) return failed;
  return `${failed}; ${labels.selection_selected} of ${labels.selection_total} selected`;
};

/** Shows pass rate, case count, error count, and finish time for one run. */
const SummaryCards = ({ run }: { run: RunRecord }) => {
  const summary = run.summary;
  const values = [
    {
      label: 'Pass rate',
      value: formatPassRate(run),
      detail: `${summary?.passedCases ?? 0} passing`,
    },
    {
      label: 'Cases',
      value: String(summary?.totalCases ?? 0),
      detail: describeCaseCounts(run),
    },
    {
      label: 'Errors',
      value: String(summary?.errorCases ?? 0),
      detail: `${summary?.metricErrorCount ?? 0} metric errors`,
    },
    {
      label: 'Finished',
      value: run.finishedAt === undefined ? 'In progress' : formatDateTime(run.finishedAt),
      detail: run.gitBranch ?? 'local workspace',
    },
  ];

  return (
    <div className="summary-grid">
      {values.map((item) => (
        <div className="card summary-card" key={item.label}>
          <span className="summary-label">{item.label}</span>
          <strong>{item.value}</strong>
          <span className="summary-detail">{item.detail}</span>
        </div>
      ))}
    </div>
  );
};

export { SummaryCards };
