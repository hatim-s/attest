import type { CaseRecord, CaseSummary, CaseVerdict, StoredMetricEvaluation } from './types.js';

/**
 * Derives the case verdict from the metrics the case was configured to run, so a metric that
 * never reported counts as an error rather than silently passing.
 */
const computeCaseVerdict = (record: CaseRecord): CaseVerdict => {
  if (record.outcome !== 'completed') return 'error';

  const metrics = new Map(record.metrics.map((metric) => [metric.metricName, metric]));
  let failed = false;
  for (const metricName of record.expectedMetrics) {
    const metric = metrics.get(metricName);
    if (metric?.status !== 'evaluated') return 'error';
    failed ||= !metric.pass;
  }
  return failed ? 'fail' : 'pass';
};

/** Averages evaluated scores; errored metrics have no score and are left out. */
const averageMetricScore = (metrics: readonly StoredMetricEvaluation[]): number | undefined => {
  const scores = metrics
    .filter((metric) => metric.status === 'evaluated')
    .map((metric) => metric.score);
  if (scores.length === 0) return undefined;
  return scores.reduce((total, score) => total + score, 0) / scores.length;
};

/** Projects one full stored case into the blob-free list and report shape. */
const summarizeCaseRecord = (record: CaseRecord): CaseSummary => {
  const score = averageMetricScore(record.metrics);
  return {
    caseId: record.caseId,
    suiteName: record.suiteName,
    outcome: record.outcome,
    verdict: computeCaseVerdict(record),
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

export { computeCaseVerdict, summarizeCaseRecord };
