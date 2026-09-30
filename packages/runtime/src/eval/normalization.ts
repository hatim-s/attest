import type { EvalRunSummary } from '@attest/contracts';
import type { StoredMetricEvaluation } from '@attest/core';
import type { CaseExecution } from '@attest/executor';

import { isAgentErrorResponse } from '../metrics/case-execution-adapter.js';
import type { NormalizedEvalCaseResult, ResolvedEvalCase } from './types.js';

/**
 * Computes a case verdict without conflating an evaluated failing metric with unavailable evidence.
 * Every expected metric must exist exactly once and be evaluated before a case can pass or fail.
 */
const classifyCaseVerdict = (
  execution: CaseExecution,
  metrics: readonly StoredMetricEvaluation[],
): NormalizedEvalCaseResult['verdict'] => {
  if (
    execution.diagnostics.lifecycleError !== undefined ||
    execution.outcome !== 'completed' ||
    isAgentErrorResponse(execution.response)
  ) {
    return 'error';
  }

  const metricsByName = new Map<string, StoredMetricEvaluation>();
  for (const metric of metrics) {
    if (metricsByName.has(metric.metricName)) return 'error';
    metricsByName.set(metric.metricName, metric);
  }

  let failed = false;
  for (const expectedMetric of execution.expectedMetrics) {
    const metric = metricsByName.get(expectedMetric);
    if (metric === undefined || metric.status === 'error') return 'error';
    failed ||= !metric.pass;
  }
  return failed ? 'fail' : 'pass';
};

/** Builds one completion-order record while retaining the resolver's configured identity. */
const normalizeCaseResult = (
  resolvedCase: ResolvedEvalCase,
  execution: CaseExecution,
  metrics: readonly StoredMetricEvaluation[],
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
  metric_results: metrics,
});

/** Aggregates mutually exclusive verdict totals and every metric infrastructure error. */
const summarizeEvalCases = (
  cases: readonly Pick<NormalizedEvalCaseResult, 'verdict' | 'metric_results'>[],
): EvalRunSummary => {
  const summary: EvalRunSummary = {
    total_cases: cases.length,
    passed_cases: 0,
    failed_cases: 0,
    error_cases: 0,
    metric_error_count: 0,
  };
  for (const evalCase of cases) {
    if (evalCase.verdict === 'pass') summary.passed_cases += 1;
    if (evalCase.verdict === 'fail') summary.failed_cases += 1;
    if (evalCase.verdict === 'error') summary.error_cases += 1;
    for (const metric of evalCase.metric_results) {
      if (metric.status === 'error') summary.metric_error_count += 1;
    }
  }
  return summary;
};

export { classifyCaseVerdict, normalizeCaseResult, summarizeEvalCases };
