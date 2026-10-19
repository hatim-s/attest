import { Link } from '@tanstack/react-router';
import type { SuiteAggregate } from '@attest/core/analytics';
import { formatDuration, formatPercent } from '../../lib/format.js';
import { useProjectKey } from '../../routes/use-project-key.js';

/** Keeps server aggregates intact so every suite view uses the same definitions. */
const SuiteTable = ({ suites }: { suites: SuiteAggregate[] }) => {
  const projectKey = useProjectKey();

  return (
    <div className="case-table-frame analytics-table-scroll">
      <table className="analytics-table" aria-label="Suites">
        <thead>
          <tr>
            {[
              'Suite',
              'Cases',
              'Passed',
              'Failed',
              'Errors',
              'Pass rate',
              'Mean score',
              'p50 duration',
              'p95 duration',
              'Metric errors',
            ].map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...suites]
            .sort((a, b) => a.suiteName.localeCompare(b.suiteName))
            .map((suite) => (
              <tr key={suite.suiteName}>
                <th scope="row">
                  <Link
                    to="/projects/$projectKey/evals/$suiteName"
                    params={{ projectKey, suiteName: suite.suiteName }}
                    search={({ branch, label }) => ({ branch, label })}
                  >
                    {suite.suiteName}
                  </Link>
                </th>
                <td>{suite.caseCount}</td>
                <td>{suite.verdicts.pass}</td>
                <td>{suite.verdicts.fail}</td>
                <td>{suite.verdicts.error}</td>
                <td>{formatPercent(suite.passRate)}</td>
                <td>{suite.meanScore?.toFixed(3) ?? 'Unscored'}</td>
                <td>{formatDuration(suite.durationMs.p50)}</td>
                <td>{formatDuration(suite.durationMs.p95)}</td>
                <td>{suite.metricErrorCount}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {suites.length === 0 ? <p className="empty-compact">No suites recorded.</p> : null}
    </div>
  );
};

export { SuiteTable };
