import type { CaseDefinition, JsonValue, MetricResult, Trace } from '@attest/contracts';

/** Defines the stable error vocabulary shared by metric evaluation and persistence. */
const METRIC_ERROR_CODES = [
  'exec_spawn_failed',
  'exec_timeout',
  'exec_nonzero_exit',
  'exec_malformed_output',
  'http_request_failed',
  'http_bad_status',
  'judge_provider_error',
  'judge_unparseable_response',
  'skipped_no_output',
  'metric_cancelled',
  'invalid_json_schema',
  'invalid_path',
  'internal_error',
] as const;

/** Names the stable failure classes a metric may report without parsing messages. */
type MetricErrorCode = (typeof METRIC_ERROR_CODES)[number];

/** Keeps assertion evaluation decoupled from the richer runner result integrated at the Phase 1 gate. */
type MetricExecutionView = {
  outcome: 'completed' | 'invocation_error' | 'timeout' | 'cancelled';
  output?: JsonValue;
  trace: Trace | null;
};

/** Carries only the case and execution data needed to build the spec evaluation document. */
type MetricContext = { caseDefinition: CaseDefinition; execution: MetricExecutionView };

/** Preserves actionable, diffable metric errors separately from assertion failures per spec §Errors vs failures. */
type MetricErrorInfo = {
  code: MetricErrorCode;
  message: string;
  details?: JsonValue;
};

/**
 * Models one metric's evaluated result XOR metric error so spec §Errors vs failures cannot be conflated.
 * Field names and the status discriminant mirror the store's StoredMetricEvaluation so persistence is a
 * near-noop mapping at the Phase 1 gate; `judgeIo` records judge request/response separately from results.
 */
type MetricEvaluation =
  | {
      metricName: string;
      kind: 'assertion' | 'exec' | 'judge';
      status: 'evaluated';
      result: MetricResult;
      judgeIo?: JsonValue;
      durationMs: number;
    }
  | {
      metricName: string;
      kind: 'assertion' | 'exec' | 'judge';
      status: 'error';
      error: MetricErrorInfo;
      durationMs: number;
    };

/** Creates the canonical error evaluation when a completed case output is unavailable. */
const skippedNoOutput = (metricName: string, kind: MetricEvaluation['kind']): MetricEvaluation => ({
  metricName,
  kind,
  status: 'error',
  error: {
    code: 'skipped_no_output',
    message: 'Metric was not evaluated because the case execution produced no completed output.',
  },
  // This only constructs the shared result object; it does not perform measurable metric work.
  durationMs: 0,
});

export {
  METRIC_ERROR_CODES,
  skippedNoOutput,
  type MetricContext,
  type MetricErrorCode,
  type MetricErrorInfo,
  type MetricEvaluation,
  type MetricExecutionView,
};
