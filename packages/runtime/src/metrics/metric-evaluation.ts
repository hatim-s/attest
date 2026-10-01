import type { JsonValue, MetricDefinition, MetricResult, TestCase, Trace } from '@attest/contracts';
import type { StoredMetricEvaluation } from '@attest/core';

/** Names the stable failure classes a metric may report without parsing messages. */
type MetricErrorCode =
  | 'exec_spawn_failed'
  | 'exec_timeout'
  | 'exec_nonzero_exit'
  | 'exec_malformed_output'
  | 'http_request_failed'
  | 'http_bad_status'
  | 'judge_provider_error'
  | 'judge_unparseable_response'
  | 'skipped_no_output'
  | 'metric_cancelled'
  | 'invalid_json_schema'
  | 'invalid_path'
  | 'internal_error';

/** Keeps metric evaluation decoupled from the richer runner result. */
type MetricExecutionView =
  | { outcome: 'completed'; output: JsonValue; trace: Trace | null }
  | {
      outcome: 'agent_error' | 'invocation_error' | 'timeout' | 'cancelled';
      trace: Trace | null;
    };

/** Carries only the case and execution data needed to build the spec evaluation document. */
type MetricContext = { caseDefinition: TestCase; execution: MetricExecutionView };

/** A context whose agent produced output, the only state in which a metric can score. */
type CompletedMetricContext = {
  caseDefinition: TestCase;
  execution: Extract<MetricExecutionView, { outcome: 'completed' }>;
};

/** Preserves actionable, diffable metric errors separately from assertion failures per spec §Errors vs failures. */
type MetricErrorInfo = {
  code: MetricErrorCode;
  message: string;
  details?: JsonValue;
};

/** The identity every evaluation is reported under. */
type MetricIdentity = Pick<MetricDefinition, 'name' | 'type'>;

/**
 * Builds the persisted error shape. Metric errors stay distinct from failing scores so a broken
 * metric never reads as a regression.
 */
const metricError = (
  definition: MetricIdentity,
  error: MetricErrorInfo,
  durationMs: number,
): StoredMetricEvaluation => ({
  metricName: definition.name,
  kind: definition.type,
  status: 'error',
  error: { kind: error.code, message: error.message },
  details: error.details,
  durationMs,
});

/** Builds the persisted evaluated shape from a contract metric result. */
const evaluatedMetric = (
  definition: MetricIdentity,
  result: MetricResult,
  durationMs: number,
): StoredMetricEvaluation => ({
  metricName: definition.name,
  kind: definition.type,
  status: 'evaluated',
  score: result.score,
  pass: result.pass,
  rationale: result.rationale,
  details: result.details,
  durationMs,
});

/** Reports why a case without scoreable output skipped its metric; agent errors get their own wording. */
const skippedNoOutput = (
  definition: MetricIdentity,
  execution: MetricExecutionView,
): StoredMetricEvaluation =>
  metricError(
    definition,
    {
      code: 'skipped_no_output',
      message:
        execution.outcome === 'agent_error'
          ? 'Metric was not evaluated because the agent returned an error envelope. Agent errors are diagnosable results, but metrics cannot score absent output.'
          : 'Metric was not evaluated because the case execution produced no completed output.',
    },
    0,
  );

export {
  evaluatedMetric,
  metricError,
  skippedNoOutput,
  type CompletedMetricContext,
  type MetricContext,
  type MetricErrorCode,
  type MetricErrorInfo,
  type MetricExecutionView,
};
