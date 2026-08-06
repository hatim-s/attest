import type { CaseDefinition, JsonValue, MetricResult, Trace } from '@attest/contracts';

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
  code:
    | 'exec_spawn_failed'
    | 'exec_timeout'
    | 'exec_nonzero_exit'
    | 'exec_malformed_output'
    | 'http_request_failed'
    | 'http_bad_status'
    | 'judge_provider_error'
    | 'judge_unparseable_response'
    | 'skipped_no_output';
  message: string;
  details?: JsonValue;
};

/** Models one metric's evaluated result XOR metric error so spec §Errors vs failures cannot be conflated. */
type MetricEvaluation =
  | {
      metricName: string;
      kind: 'assertion' | 'exec' | 'judge';
      status: 'evaluated';
      result: MetricResult;
      durationMs: number;
    }
  | {
      metricName: string;
      kind: 'assertion' | 'exec' | 'judge';
      status: 'metric_error';
      error: MetricErrorInfo;
      durationMs: number;
    };

export {
  type MetricContext,
  type MetricErrorInfo,
  type MetricEvaluation,
  type MetricExecutionView,
};
