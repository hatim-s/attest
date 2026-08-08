import type { JsonValue, MetricResult, TestCase, Trace } from '@attest/contracts';

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

/** Preserves forward-compatible persisted error kinds alongside the runtime's stable vocabulary. */
type StoredErrorKind = MetricErrorCode | (string & {});

/** Keeps metric evaluation decoupled from the richer runner result integrated at the Phase 1 gate. */
type MetricExecutionView =
  | { outcome: 'completed'; output: JsonValue; trace: Trace | null }
  | {
      outcome: 'agent_error' | 'invocation_error' | 'timeout' | 'cancelled';
      output?: JsonValue;
      trace: Trace | null;
    };

/** Carries only the case and execution data needed to build the spec evaluation document. */
type MetricContext = { caseDefinition: TestCase; execution: MetricExecutionView };

/** Preserves actionable, diffable metric errors separately from assertion failures per spec §Errors vs failures. */
type MetricErrorInfo = {
  code: StoredErrorKind;
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
      durationMs?: number;
    }
  | {
      metricName: string;
      kind: 'assertion' | 'exec' | 'judge';
      status: 'error';
      error: MetricErrorInfo;
      rationale?: string;
      judgeIo?: JsonValue;
      durationMs?: number;
    };

/** Creates the canonical error evaluation when a case has no scoreable agent output. */
const skippedNoOutput = (
  metricName: string,
  kind: MetricEvaluation['kind'],
  execution?: MetricExecutionView,
): MetricEvaluation => ({
  metricName,
  kind,
  status: 'error',
  error: {
    code: 'skipped_no_output',
    message:
      execution?.outcome === 'agent_error'
        ? 'Metric was not evaluated because the agent returned an error envelope. Agent errors are diagnosable results, but metrics cannot score absent output.'
        : 'Metric was not evaluated because the case execution produced no completed output.',
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
  type StoredErrorKind,
};
