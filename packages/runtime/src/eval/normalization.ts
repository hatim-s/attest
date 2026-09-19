import type { EvalRunSummary } from '@attest/contracts';

import type { MetricEvaluation } from '../metrics/metric-evaluation.js';
import type { CaseExecution } from '../runner/types.js';
import type {
  NormalizedEvalAttempt,
  NormalizedEvalCaseResult,
  NormalizedEvalMetricResult,
  ResolvedEvalCase,
} from './types.js';

/** Converts bounded runner attempts into a stable zero-based machine projection. */
const normalizeAttempts = (execution: CaseExecution): NormalizedEvalAttempt[] =>
  execution.attempts.map((attempt, attemptIndex) => ({
    attempt_index: attemptIndex,
    status: attempt.status,
    duration_ms: attempt.durationMs,
    diagnostics: attempt.diagnostics,
    warnings: attempt.warnings,
    ...(attempt.rawExcerpt === undefined ? {} : { raw_excerpt: attempt.rawExcerpt }),
    ...(attempt.status === 'ok'
      ? {}
      : { error: { code: attempt.error.code, message: attempt.error.message } }),
  }));

/** Retains the evaluated-result XOR infrastructure-error distinction from the metric engine. */
const normalizeMetricResults = (
  metrics: readonly MetricEvaluation[],
): NormalizedEvalMetricResult[] =>
  metrics.map((metric) => {
    if (metric.status === 'evaluated') {
      return {
        metric_name: metric.metricName,
        kind: metric.kind,
        status: 'evaluated',
        score: metric.result.score,
        pass: metric.result.pass,
        ...(metric.result.rationale === undefined ? {} : { rationale: metric.result.rationale }),
        ...(metric.result.details === undefined ? {} : { details: metric.result.details }),
        ...(metric.judgeIo === undefined ? {} : { judge_io: metric.judgeIo }),
        ...(metric.durationMs === undefined ? {} : { duration_ms: metric.durationMs }),
      };
    }

    return {
      metric_name: metric.metricName,
      kind: metric.kind,
      status: 'error',
      error: {
        code: metric.error.code,
        message: metric.error.message,
        ...(metric.error.details === undefined ? {} : { details: metric.error.details }),
      },
      ...(metric.rationale === undefined ? {} : { rationale: metric.rationale }),
      ...(metric.judgeIo === undefined ? {} : { judge_io: metric.judgeIo }),
      ...(metric.durationMs === undefined ? {} : { duration_ms: metric.durationMs }),
    };
  });

/**
 * Computes a case verdict without conflating an evaluated failing metric with unavailable evidence.
 * Every expected metric must exist exactly once and be evaluated before a case can pass or fail.
 */
const classifyCaseVerdict = (
  execution: CaseExecution,
  metrics: readonly MetricEvaluation[],
): NormalizedEvalCaseResult['verdict'] => {
  if (execution.outcome !== 'completed' || !('output' in execution.response)) {
    return 'error';
  }

  const metricsByName = new Map<string, MetricEvaluation>();
  for (const metric of metrics) {
    if (metricsByName.has(metric.metricName)) return 'error';
    metricsByName.set(metric.metricName, metric);
  }

  let failed = false;
  for (const expectedMetric of execution.expectedMetrics) {
    const metric = metricsByName.get(expectedMetric);
    if (metric === undefined || metric.status === 'error') return 'error';
    failed ||= metric.result.pass !== true;
  }
  return failed ? 'fail' : 'pass';
};

/** Builds one completion-order record while retaining the resolver's configured identity. */
const normalizeCaseResult = (
  resolvedCase: ResolvedEvalCase,
  execution: CaseExecution,
  metrics: readonly MetricEvaluation[],
  completionIndex: number,
): NormalizedEvalCaseResult => ({
  test_id: resolvedCase.test_id,
  case_id: resolvedCase.case_id,
  configured_index: resolvedCase.configured_index,
  completion_index: completionIndex,
  outcome: execution.outcome,
  verdict: classifyCaseVerdict(execution, metrics),
  started_at: execution.startedAt,
  duration_ms: execution.durationMs,
  attempts: normalizeAttempts(execution),
  metric_results: normalizeMetricResults(metrics),
});

/** Aggregates mutually exclusive verdict totals and every metric infrastructure error. */
const summarizeEvalCases = (
  cases: readonly Pick<NormalizedEvalCaseResult, 'verdict' | 'metric_results'>[],
): EvalRunSummary => ({
  total_cases: cases.length,
  passed_cases: cases.filter(({ verdict }) => verdict === 'pass').length,
  failed_cases: cases.filter(({ verdict }) => verdict === 'fail').length,
  error_cases: cases.filter(({ verdict }) => verdict === 'error').length,
  metric_error_count: cases.reduce(
    (count, evalCase) =>
      count + evalCase.metric_results.filter(({ status }) => status === 'error').length,
    0,
  ),
});

export {
  classifyCaseVerdict,
  normalizeAttempts,
  normalizeCaseResult,
  normalizeMetricResults,
  summarizeEvalCases,
};
