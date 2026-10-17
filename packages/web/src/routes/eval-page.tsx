import { useMemo } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useSuiteHistory } from '../api/queries.js';
import { AnalyticsChart } from '../components/runs/analytics-chart.js';
import { ErrorNotice, Loading } from '../components/shared/ui.js';
import { formatDateTime, formatPercent } from '../lib/format.js';

const formatScore = (value: number) => value.toFixed(3);

const route = getRouteApi('/workspace/evals/$suiteName');

/** Keeps each measure on its own scale and preserves run provenance beside the charts. */
const EvalPage = () => {
  const { suiteName } = route.useParams();
  const { limit } = route.useSearch();
  const navigate = useNavigate();
  const historyQuery = useSuiteHistory(suiteName, limit);
  const history = historyQuery.data;
  const points = useMemo(() => [...(history?.points ?? [])].reverse(), [history?.points]);

  const { labels, passRates, meanScores } = useMemo(
    () => ({
      labels: points.map(
        (point) =>
          `${point.runId}\nBranch: ${point.gitBranch ?? 'Unknown'}\nSHA: ${point.gitSha ?? 'Unknown'}`,
      ),
      passRates: points.map((point) => point.aggregate.passRate),
      meanScores: points.map((point) => point.aggregate.meanScore),
    }),
    [points],
  );

  return (
    <section aria-label="Suite history">
      <h1>{suiteName}</h1>
      <label>
        Runs to examine{' '}
        <select
          value={limit}
          onChange={(event) =>
            void navigate({
              to: '/evals/$suiteName',
              params: { suiteName },
              search: (previous) => ({ ...previous, limit: Number(event.target.value) }),
            })
          }
        >
          {[10, 20, 50, ...([10, 20, 50].includes(limit) ? [] : [limit])]
            .sort((a, b) => a - b)
            .map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
        </select>
      </label>
      {historyQuery.isLoading ? <Loading label="Loading suite history" /> : null}
      {historyQuery.error !== null ? <ErrorNotice error={historyQuery.error} /> : null}
      {history !== undefined ? (
        <>
          <p className="empty-compact">
            {history.runsExamined} non-running runs examined.{' '}
            {history.exhausted ? 'All runs examined.' : 'Limit reached, older runs may exist.'}{' '}
            {points.length} runs contain this suite.
          </p>
          {points.length === 0 ? (
            <p className="empty-compact">No history points in the examined runs.</p>
          ) : (
            <>
              <div className="chart-grid">
                <AnalyticsChart
                  title="Suite pass rate"
                  labels={labels}
                  values={passRates}
                  measure="Pass rate (%)"
                  min={0}
                  max={1}
                  formatValue={formatPercent}
                />
                <AnalyticsChart
                  title="Suite mean score"
                  labels={labels}
                  values={meanScores}
                  measure="Mean score"
                  formatValue={formatScore}
                />
              </div>
              <div className="case-table-frame analytics-table-scroll">
                <table className="analytics-table">
                  <caption>
                    History values, oldest first. Unscored runs leave a gap in the score chart.
                  </caption>
                  <thead>
                    <tr>
                      {['Run', 'Created', 'Branch', 'SHA', 'Pass rate', 'Mean score'].map(
                        (name) => (
                          <th key={name} scope="col">
                            {name}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((point) => (
                      <tr key={point.runId}>
                        <th scope="row">
                          <Link
                            to="/runs/$runId"
                            params={{ runId: point.runId }}
                            search={(previous) => ({ ...previous, tab: 'suites' })}
                          >
                            {point.runId}
                          </Link>
                        </th>
                        <td>{formatDateTime(point.createdAt)}</td>
                        <td>{point.gitBranch ?? 'Unknown'}</td>
                        <td>{point.gitSha ?? 'Unknown'}</td>
                        <td>{formatPercent(point.aggregate.passRate)}</td>
                        <td>{point.aggregate.meanScore?.toFixed(3) ?? 'Unscored'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
};

export { EvalPage };
