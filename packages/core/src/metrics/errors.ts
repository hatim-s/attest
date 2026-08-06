import { AttestError, type JsonValue } from '@attest/contracts';

import type { MetricErrorCode } from './metric-evaluation.js';

/** Enumerates stable metric-boundary failures without requiring callers to parse messages. */
type AttestMetricErrorCode = Extract<
  MetricErrorCode,
  | 'invalid_path'
  | 'invalid_json_schema'
  | 'judge_provider_error'
  | 'judge_unparseable_response'
  | 'metric_cancelled'
>;

/** Carries optional JSON evidence while preserving the shared AttestError cause chain. */
type AttestMetricErrorOptions = ErrorOptions & { details?: JsonValue };

/** Raised for defensive invariant violations inside metric evaluation because config is validated upstream. */
class AttestMetricError extends AttestError {
  declare readonly code: AttestMetricErrorCode;
  readonly details: JsonValue | undefined;

  constructor(code: AttestMetricErrorCode, message: string, options?: AttestMetricErrorOptions) {
    super(code, message, options);
    this.details = options?.details;
  }
}

export { AttestMetricError, type AttestMetricErrorCode, type AttestMetricErrorOptions };
