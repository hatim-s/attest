import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { AnalyticsChart } from './analytics-chart.js';
import { createRunTrends } from './loaded-analytics.js';
import { formatPercent } from '../../lib/format.js';

/** Keeps chart arrays stable while the run page polls unchanged results. */
const TrendChart = ({ group }: { group: ReturnType<typeof createRunTrends>['groups'][number] }) => {
  const { labels, values } = useMemo(
    () => ({
      labels: group.points.map(({ run }) => `${run.id}\n${group.name}`),
      values: group.points.map(({ passRate }) => passRate),
    }),
    [group],
  );

  return (
    <AnalyticsChart
      title={group.name}
      measure="Pass rate (%)"
      min={0}
      max={1}
      formatValue={formatPercent}
      labels={labels}
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
    <section className="distribution-panel" aria-label="Loaded run trends">
      <h2>Loaded run trends</h2>
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
        Only the {runs.length} loaded runs are included. Skipped {trends.runningRuns} running,{' '}
        {trends.missingSummary} without a summary and {trends.emptyRuns} with zero cases.
      </p>
      <div className="chart-grid">
        {trends.groups.map((group) => (
          <TrendChart key={group.name} group={group} />
        ))}
      </div>
      {trends.groups.length === 0 ? (
        <p className="empty-compact">No loaded runs have a usable summary.</p>
      ) : (
        <div className="case-table-frame analytics-table-scroll">
          <table className="analytics-table">
            <caption>Loaded run pass rates, oldest first within each group</caption>
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
                      >
                        {run.id}
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
