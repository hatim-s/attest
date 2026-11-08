import { useMemo } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useEvalRuns } from '../api/queries.js';
import { AnalyticsChart } from '../components/runs/analytics-chart.js';
import { ErrorNotice, Heading, Loading } from '../components/shared/ui.js';
import { formatCount, formatDateTime, formatPercent, shortId } from '../lib/format.js';

const formatScore = (value: number) => value.toFixed(3);

const route = getRouteApi('/projects/$projectKey/workspace/evals/$suiteName');

/** Keeps each measure on its own scale and preserves run provenance beside the charts. */
const EvalPage = () => {
  const { projectKey, suiteName } = route.useParams();
  const { limit } = route.useSearch();
  const navigate = useNavigate();
  const historyQuery = useEvalRuns(projectKey, suiteName, limit);
  const history = historyQuery.data;
  const points = useMemo(() => [...(history?.items ?? [])].reverse(), [history?.items]);

  const { runs, passRates, meanScores } = useMemo(
    () => ({
      runs: points.map(({ runId, createdAt, gitBranch, gitSha }) => ({
        id: runId,
        createdAt,
        gitBranch: gitBranch ?? undefined,
        gitSha: gitSha ?? undefined,
      })),
      passRates: points.map((point) => point.passRate),
      meanScores: points.map((point) => point.meanScore),
    }),
    [points],
  );

  return (
    <section className="stack" aria-label="Suite history">
      <Heading
        level={1}
        eyebrow="Eval suite"
        title={suiteName}
        meta={
          history === undefined
            ? undefined
            : history.nextCursor === undefined
              ? `All ${formatCount(points.length, 'run')}`
              : `Newest ${formatCount(points.length, 'run')}`
        }
      >
        <label className="control">
          Look back
          <select
            value={limit}
            onChange={(event) =>
              void navigate({
                to: '/projects/$projectKey/evals/$suiteName',
                params: { projectKey, suiteName },
                search: (previous) => ({ ...previous, limit: Number(event.target.value) }),
              })
            }
          >
            {[10, 20, 50].map((value) => (
              <option key={value} value={value}>
                {value} runs
              </option>
            ))}
          </select>
        </label>
      </Heading>
      {historyQuery.isLoading ? <Loading label="Loading suite history" /> : null}
      {historyQuery.error !== null ? <ErrorNotice error={historyQuery.error} /> : null}
      {history !== undefined ? (
        <>
          {points.length === 0 ? (
            <p className="empty-compact">{`No run includes ${suiteName} yet.`}</p>
          ) : (
            <>
              <div className="chart-grid">
                <AnalyticsChart
                  title="Pass rate"
                  runs={runs}
                  values={passRates}
                  measure="Pass rate"
                  min={0}
                  max={1}
                  formatValue={formatPercent}
                />
                <AnalyticsChart
                  title="Mean score"
                  runs={runs}
                  values={meanScores}
                  emptyMessage="None of these runs has a score."
                  measure="Mean score"
                  formatValue={formatScore}
                />
              </div>
              <div className="case-table-frame analytics-table-scroll">
                <table className="analytics-table">
                  <caption>
                    Oldest first. A run that did not complete has no pass rate, and an unscored run
                    leaves a gap in the score chart.
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
                            to="/projects/$projectKey/runs/$runId"
                            params={{ projectKey, runId: point.runId }}
                            search={({ branch, label }) => ({ branch, label, tab: 'suites' })}
                            title={point.runId}
                          >
                            {shortId(point.runId)}
                          </Link>
                        </th>
                        <td>{formatDateTime(point.createdAt)}</td>
                        <td>{point.gitBranch ?? '—'}</td>
                        <td className="mono" title={point.gitSha ?? undefined}>
                          {point.gitSha === null ? '—' : shortId(point.gitSha, 7)}
                        </td>
                        <td>
                          {point.passRate === null ? 'Incomplete' : formatPercent(point.passRate)}
                        </td>
                        <td>{point.meanScore?.toFixed(3) ?? 'Unscored'}</td>
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
