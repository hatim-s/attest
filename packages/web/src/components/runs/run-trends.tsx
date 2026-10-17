import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { AnalyticsChart } from './analytics-chart.js';
import { createRunTrends } from './loaded-analytics.js';
import { formatCount, formatPercent, shortId } from '../../lib/format.js';

/** Keeps chart arrays stable while the run page polls unchanged results. */
const TrendChart = ({ group }: { group: ReturnType<typeof createRunTrends>['groups'][number] }) => {
  const { runs, values } = useMemo(
    () => ({
      runs: group.points.map(({ run }) => run),
      values: group.points.map(({ passRate }) => passRate),
    }),
    [group],
  );

  return (
    <AnalyticsChart
      title={group.name}
      measure="Pass rate"
      min={0}
      max={1}
      formatValue={formatPercent}
      runs={runs}
      values={values}
    />
  );
};

/** Facets groups so branch or label identity never depends on a generated or recycled hue. */
const RunTrends = ({ runs }: { runs: RunRecord[] }) => {
  const [labelKey, setLabelKey] = useState('');
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run.labels ?? {})))].sort();

  const trends = useMemo(
    () =>
      createRunTrends(
        runs,
        labelKey === '' ? { kind: 'branch' } : { kind: 'label', key: labelKey },
      ),
    [runs, labelKey],
  );

  return (
    <section className="distribution-panel" aria-label="Recent runs">
      <h2>Pass rate by {labelKey === '' ? 'branch' : labelKey}</h2>
      <label>
        Group by{' '}
        <select value={labelKey} onChange={(event) => setLabelKey(event.target.value)}>
          <option value="">Branch</option>
          {keys.map((key) => (
            <option key={key} value={key}>
              Label: {key}
            </option>
          ))}
        </select>
      </label>
      <p className="empty-compact">
        {[
          formatCount(runs.length, 'recent run'),
          trends.runningRuns > 0 ? `${trends.runningRuns} still running` : '',
          trends.missingSummary > 0 ? `${trends.missingSummary} without a summary` : '',
          trends.emptyRuns > 0 ? `${trends.emptyRuns} with no cases` : '',
        ]
          .filter((part) => part !== '')
          .join(', ')}
      </p>
      <div className="chart-grid">
        {trends.groups.map((group) => (
          <TrendChart key={group.name} group={group} />
        ))}
      </div>
      {trends.groups.length === 0 ? (
        <p className="empty-compact">No finished runs with cases yet.</p>
      ) : (
        <div className="case-table-frame analytics-table-scroll">
          <table className="analytics-table">
            <caption>Oldest first within each group</caption>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Run</th>
                <th scope="col">Pass rate</th>
              </tr>
            </thead>
            <tbody>
              {trends.groups.flatMap((group) =>
                group.points.map(({ run, passRate }) => (
                  <tr key={`${group.name}:${run.id}`}>
                    <th scope="row">{group.name}</th>
                    <td>
                      <Link
                        to="/runs/$runId"
                        params={{ runId: run.id }}
                        search={(previous) => ({ ...previous, tab: 'cases' })}
                        title={run.id}
                      >
                        {shortId(run.id)}
                      </Link>
                    </td>
                    <td>{formatPercent(passRate)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export { RunTrends };
