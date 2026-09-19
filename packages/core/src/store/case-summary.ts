import type { CaseRecord, CaseSummary, StoredMetricEvaluation } from './types.js';

/** Computes the case verdict from the configured metric names. */
const classifyStoredCase = (record: CaseRecord): CaseSummary['verdict'] => {
  if (record.outcome !== 'completed') return 'error';

  const metrics = new Map(record.metrics.map((metric) => [metric.metricName, metric]));
  let failed = false;
  for (const metricName of record.expectedMetrics) {
    const metric = metrics.get(metricName);
    if (metric?.status !== 'evaluated' || metric.pass === undefined) return 'error';
    failed ||= metric.pass === false;
  }
  return failed ? 'fail' : 'pass';
};

/** Averages the scores from metrics that completed evaluation. */
const averageMetricScore = (metrics: readonly StoredMetricEvaluation[]): number | undefined => {
  const scores = metrics.flatMap((metric) =>
    metric.status === 'evaluated' && metric.score !== undefined ? [metric.score] : [],
  );
  if (scores.length === 0) return undefined;
  return scores.reduce((total, score) => total + score, 0) / scores.length;
};

/** Projects one full stored case into the shared list and report shape. */
const summarizeCaseRecord = (record: CaseRecord): CaseSummary => {
  const score = averageMetricScore(record.metrics);
  return {
    caseId: record.caseId,
    suiteName: record.suiteName,
    outcome: record.outcome,
    verdict: classifyStoredCase(record),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    ...(score === undefined ? {} : { score }),
    metricCounts: {
      expected: record.expectedMetrics.length,
      evaluated: record.metrics.filter(({ status }) => status === 'evaluated').length,
      passed: record.metrics.filter(({ pass, status }) => status === 'evaluated' && pass === true)
        .length,
      errors: record.metrics.filter(({ status }) => status === 'error').length,
    },
  };
};

export { averageMetricScore, classifyStoredCase, summarizeCaseRecord };
