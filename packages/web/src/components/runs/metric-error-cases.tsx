import type { CaseSummary } from '@attest/core/records';
import { Link } from '@tanstack/react-router';
import { Badge } from '../shared/ui.js';

/** Links to case evidence without fetching every full record to construct a per-metric table. */
const MetricErrorCases = ({ cases, runId }: { cases: CaseSummary[]; runId: string }) => {
  const errors = cases.filter((item) => item.metricCounts.errors > 0);

  return (
    <div className="case-table-frame analytics-table-scroll">
      <table className="analytics-table">
        <caption>Cases with metric errors in loaded summaries</caption>
        <thead>
          <tr>
            <th scope="col">Suite</th>
            <th scope="col">Case</th>
            <th scope="col">Verdict</th>
            <th scope="col">Metric errors</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((item) => (
            <tr key={`${item.suiteName}:${item.caseId}`}>
              <th scope="row">{item.suiteName}</th>
              <td>
                <Link
                  to="/runs/$runId/cases/$suiteName/$caseId"
                  params={{ runId, suiteName: item.suiteName, caseId: item.caseId }}
                  search={{ tab: 'distributions' }}
                  state={{ caseOpenedFromRun: true }}
                >
                  {item.caseId}
                </Link>
              </td>
              <td>
                <Badge tone={item.verdict}>{item.verdict}</Badge>
              </td>
              <td>{item.metricCounts.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {errors.length === 0 ? (
        <p className="empty-compact">No metric errors in loaded cases.</p>
      ) : null}
    </div>
  );
};

export { MetricErrorCases };
