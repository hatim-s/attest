import { isAgentErrorResponse } from '@attest/contracts';

import type {
  CaseRecord,
  CaseSummary,
  CaseVerdict,
  RunSummary,
  StoredMetricEvaluation,
} from './types.js';

/**
 * The case facts a verdict reads. Hosts derive the two flags from whatever they hold, a live
 * execution, a stored record or a SQL row, so every host applies one rule.
 */
type CaseVerdictEvidence = Pick<CaseRecord, 'outcome' | 'expectedMetrics'> & {
  /** A lifecycle hook or sandbox step failed around the agent call. */
  lifecycleFailed: boolean;
  /** The agent answered with an error envelope instead of an output. */
  agentErrored: boolean;
};

/** The metric facts a verdict reads, keeping `pass` tied to an evaluated status. */
type MetricVerdictEvidence =
  | Pick<Extract<StoredMetricEvaluation, { status: 'evaluated' }>, 'metricName' | 'status' | 'pass'>
  | Pick<Extract<StoredMetricEvaluation, { status: 'error' }>, 'metricName' | 'status'>;

/**
 * Separates a failing metric from missing evidence. Infrastructure or lifecycle failure, an agent
 * error envelope, a repeated metric name, or an expected metric that never evaluated makes the
 * case an error; otherwise any failed expected metric fails it.
 */
const computeCaseVerdict = (
  evidence: CaseVerdictEvidence,
  metrics: readonly MetricVerdictEvidence[],
): CaseVerdict => {
  if (evidence.outcome !== 'completed' || evidence.lifecycleFailed || evidence.agentErrored) {
    return 'error';
  }

  const metricsByName = new Map<string, MetricVerdictEvidence>();

  for (const metric of metrics) {
    if (metricsByName.has(metric.metricName)) return 'error';
    metricsByName.set(metric.metricName, metric);
  }

  let failed = false;

  for (const metricName of evidence.expectedMetrics) {
    const metric = metricsByName.get(metricName);

    if (metric?.status !== 'evaluated') return 'error';
    failed ||= !metric.pass;
  }

  return failed ? 'fail' : 'pass';
};

/** Totals verdicts and every metric error row, so runtime results and stored runs count alike. */
const summarizeVerdicts = (
  cases: readonly {
    verdict: CaseVerdict;
    metrics: readonly Pick<StoredMetricEvaluation, 'status'>[];
  }[],
): RunSummary => ({
  totalCases: cases.length,
  passedCases: cases.filter(({ verdict }) => verdict === 'pass').length,
  failedCases: cases.filter(({ verdict }) => verdict === 'fail').length,
  errorCases: cases.filter(({ verdict }) => verdict === 'error').length,
  metricErrorCount: cases
    .flatMap(({ metrics }) => metrics)
    .filter(({ status }) => status === 'error').length,
});

/** Applies the verdict rule to a stored case, which carries its own evidence. */
const caseRecordVerdict = (record: CaseRecord): CaseVerdict =>
  computeCaseVerdict(
    {
      outcome: record.outcome,
      expectedMetrics: record.expectedMetrics,
      lifecycleFailed: record.diagnostics.lifecycleError !== undefined,
      agentErrored: record.outcome === 'completed' && isAgentErrorResponse(record.response),
    },
    record.metrics,
  );

/** Averages evaluated scores; errored metrics have no score and are left out. */
const averageMetricScore = (metrics: readonly StoredMetricEvaluation[]): number | undefined => {
  const scores = metrics.flatMap((metric) => (metric.status === 'evaluated' ? [metric.score] : []));

  if (scores.length === 0) return undefined;

  return scores.reduce((total, score) => total + score, 0) / scores.length;
};

/** Projects one full stored case into the blob-free list and report shape. */
const summarizeCaseRecord = (record: CaseRecord): CaseSummary => {
  const score = averageMetricScore(record.metrics);

  const summary: CaseSummary = {
    caseId: record.caseId,
    suiteName: record.suiteName,
    outcome: record.outcome,
    verdict: caseRecordVerdict(record),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    metricCounts: {
      expected: record.expectedMetrics.length,
      evaluated: record.metrics.filter(({ status }) => status === 'evaluated').length,
      passed: record.metrics.filter((metric) => metric.status === 'evaluated' && metric.pass)
        .length,
      errors: record.metrics.filter(({ status }) => status === 'error').length,
    },
  };

  if (score !== undefined) summary.score = score;

  return summary;
};

export {
  caseRecordVerdict,
  computeCaseVerdict,
  summarizeCaseRecord,
  summarizeVerdicts,
  type CaseVerdictEvidence,
  type MetricVerdictEvidence,
};
