import type { CaseRecord } from '@attest/core/records';

/**
 * Why a case did not pass, in one line, from its record: the invocation error, the agent's error
 * envelope, the first failed or errored check, or an expected check that never evaluated.
 */
const failureReason = (record: CaseRecord): string => {
  if (record.outcome !== 'completed') return record.errorMessage;

  if (record.response.error !== undefined) return record.response.error.message;

  const failed = record.metrics.find((metric) => metric.status === 'error' || !metric.pass);

  if (failed?.status === 'error') return `${failed.metricName}: ${failed.error.message}`;

  if (failed !== undefined)
    return `${failed.metricName}: ${failed.rationale ?? `scored ${failed.score}`}`;

  const missing = record.expectedMetrics.find(
    (name) => !record.metrics.some((metric) => metric.metricName === name),
  );

  return missing === undefined ? 'No failed check was recorded.' : `${missing} did not evaluate.`;
};

export { failureReason };
