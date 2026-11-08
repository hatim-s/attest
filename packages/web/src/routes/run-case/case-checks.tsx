import type { CaseRecord, StoredMetricEvaluation } from '@attest/core/records';
import { StatusMark } from '../../components/marks/status-mark.js';
import { formatCount } from '../../lib/format.js';

const passed = (metric: StoredMetricEvaluation) => metric.status === 'evaluated' && metric.pass;

/** One check: its name and kind, the score, then the reason the evaluator gave. */
const CheckRow = ({ metric }: { metric: StoredMetricEvaluation }) => (
  <li data-pass={passed(metric)}>
    <StatusMark tone={passed(metric) ? 'passing' : 'failing'} />
    <span className="attest-an">
      <code>{metric.metricName}</code> <span className="attest-dim">{metric.kind}</span>
    </span>
    <span className="attest-dim">
      {metric.status === 'evaluated' ? `score ${metric.score}` : 'did not evaluate'}
    </span>
    {(metric.status === 'error' || metric.rationale !== undefined) && (
      <p className={passed(metric) ? 'attest-why' : 'attest-why attest-hot'}>
        {metric.status === 'error' ? (metric.rationale ?? metric.error.message) : metric.rationale}
      </p>
    )}
  </li>
);

/**
 * Failed and errored checks stay open with their reasons; passed checks fold behind one line.
 * An expected check with no evaluation is named, since it makes the case an error.
 */
const CaseChecks = ({ record }: { record: CaseRecord }) => {
  const failing = record.metrics.filter((metric) => !passed(metric));
  const passing = record.metrics.filter(passed);

  const missing = record.expectedMetrics.filter(
    (name) => !record.metrics.some((metric) => metric.metricName === name),
  );

  if (record.metrics.length === 0 && missing.length === 0)
    return (
      <p className="attest-dim">
        {record.outcome === 'completed'
          ? 'No checks ran.'
          : 'Not evaluated. The case has no output.'}
      </p>
    );

  return (
    <>
      {failing.length > 0 && (
        <ul className="attest-checks">
          {failing.map((metric) => (
            <CheckRow key={metric.metricName} metric={metric} />
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <p className="attest-hot">Expected but not evaluated: {missing.join(', ')}.</p>
      )}
      {passing.length > 0 && (
        <details className="attest-disc attest-disc-sm">
          <summary>
            {failing.length + missing.length > 0
              ? `${formatCount(passing.length, 'other check')} passed`
              : `All ${formatCount(passing.length, 'check')} passed`}
          </summary>
          <ul className="attest-checks">
            {passing.map((metric) => (
              <CheckRow key={metric.metricName} metric={metric} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
};

export { CaseChecks };
