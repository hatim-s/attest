import { isAgentErrorResponse, type EvalRunSummary } from '@attest/contracts';
import {
  computeCaseVerdict,
  summarizeVerdicts,
  type CaseVerdict,
  type StoredMetricEvaluation,
} from '@attest/core';

import type { CaseExecution, NormalizedEvalCaseResult, ResolvedEvalCase } from './types.js';

/** Reads the verdict evidence from a live execution and applies core's rule. */
const classifyCaseVerdict = (
  execution: CaseExecution,
  metrics: readonly StoredMetricEvaluation[],
): CaseVerdict =>
  computeCaseVerdict(
    {
      outcome: execution.outcome,
      expectedMetrics: execution.expectedMetrics,
      lifecycleFailed: execution.diagnostics.lifecycleError !== undefined,
      agentErrored: execution.outcome === 'completed' && isAgentErrorResponse(execution.response),
    },
    metrics,
  );

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

/** Builds the record for a case whose runner failed, so it still counts as an error verdict. */
const normalizeInfrastructureFailure = (
  resolvedCase: ResolvedEvalCase,
  failure: { completionIndex: number; cancelled: boolean; startedAt: string },
): NormalizedEvalCaseResult => ({
  test_id: resolvedCase.test_id,
  case_id: resolvedCase.case_id,
  configured_index: resolvedCase.configured_index,
  completion_index: failure.completionIndex,
  outcome: failure.cancelled ? 'cancelled' : 'invocation_error',
  verdict: 'error',
  started_at: failure.startedAt,
  duration_ms: 0,
  metric_results: [],
});

/** Projects core's run totals onto the snake_case event summary. */
const summarizeEvalCases = (
  cases: readonly Pick<NormalizedEvalCaseResult, 'verdict' | 'metric_results'>[],
): EvalRunSummary => {
  const summary = summarizeVerdicts(
    cases.map(({ verdict, metric_results }) => ({ verdict, metrics: metric_results })),
  );

  return {
    total_cases: summary.totalCases,
    passed_cases: summary.passedCases,
    failed_cases: summary.failedCases,
    error_cases: summary.errorCases,
    metric_error_count: summary.metricErrorCount,
  };
};

export { normalizeCaseResult, normalizeInfrastructureFailure, summarizeEvalCases };
