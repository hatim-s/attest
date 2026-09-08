import type { RunRecord } from '../../api/types.js';
import { formatDateTime, formatPercent } from '../../lib/format.js';
import { Card } from '../shared/ui.js';

/** Calculates the run pass rate without pretending an empty run is successful. */
const runPassRate = (run: RunRecord): number | undefined => {
  if (run.summary === undefined || run.summary.totalCases === 0) return undefined;
  return run.summary.passedCases / run.summary.totalCases;
};

/** Shows the four values most useful for deciding whether to inspect a run. */
const SummaryCards = ({ run }: { run: RunRecord }) => {
  const summary = run.summary;
  const values = [
    {
      label: 'Pass rate',
      value: formatPercent(runPassRate(run)),
      detail:
        summary === undefined
          ? 'Available when the run finishes'
          : `${summary.passedCases} passing`,
    },
    {
      label: 'Cases',
      value: summary === undefined ? 'Pending' : String(summary.totalCases),
      detail:
        summary === undefined
          ? 'Results appear below as they arrive'
          : `${summary.failedCases} failed`,
    },
    {
      label: 'Errors',
      value: summary === undefined ? 'Pending' : String(summary.errorCases),
      detail:
        summary === undefined
          ? 'Available when the run finishes'
          : `${summary.metricErrorCount} metric errors`,
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
        <Card className="summary-card" key={item.label}>
          <span className="summary-label">{item.label}</span>
          <strong>{item.value}</strong>
          <span className="summary-detail">{item.detail}</span>
        </Card>
      ))}
    </div>
  );
};

export { SummaryCards, runPassRate };
