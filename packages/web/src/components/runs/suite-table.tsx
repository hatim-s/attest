import { Link } from '@tanstack/react-router';
import type { EvalSlice } from '@attest/core/records';
import { formatPercent } from '../../lib/format.js';
import { useProjectKey } from '../../routes/use-project-key.js';

/** Shows each eval's stored slice counts; only a complete slice has a pass rate. */
const SuiteTable = ({ suites }: { suites: readonly EvalSlice[] }) => {
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
              'Skipped',
              'Pass rate',
              'Mean score',
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
                <td>{suite.counts.recorded}</td>
                <td>{suite.counts.passed}</td>
                <td>{suite.counts.failed}</td>
                <td>{suite.counts.errored}</td>
                <td>{suite.counts.skipped}</td>
                <td>{suite.passRate === null ? 'Incomplete' : formatPercent(suite.passRate)}</td>
                <td>{suite.meanScore?.toFixed(3) ?? 'Unscored'}</td>
                <td>{suite.counts.metricErrors}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {suites.length === 0 ? <p className="empty-compact">No suites recorded.</p> : null}
    </div>
  );
};

export { SuiteTable };
