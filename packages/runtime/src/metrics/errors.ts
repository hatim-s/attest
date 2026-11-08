import * as Data from 'effect/Data';

import { AttestError, foreignMessage, type JsonValue } from '@attest/contracts';

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

/**
 * Thrown inside metric evaluation for failures that end one metric: invalid paths or schemas that
 * bypassed upstream validation, judge provider errors, timeouts, and cancellation. The dispatcher
 * turns it into a metric error result, so it never aborts the rest of the case.
 */
class AttestMetricError extends AttestError {
  declare readonly code: AttestMetricErrorCode;
  readonly details: JsonValue | undefined;

  constructor(code: AttestMetricErrorCode, message: string, options?: AttestMetricErrorOptions) {
    super(code, message, options);
    this.details = options?.details;
  }
}

type MetricOperationReason = 'owner_interrupted' | 'process_cleanup_unconfirmed';

const METRIC_OPERATION_MESSAGES = {
  owner_interrupted: 'Metric owner interrupted.',
  process_cleanup_unconfirmed: 'Metric process cleanup is unconfirmed.',
} as const satisfies Record<MetricOperationReason, string>;

/**
 * A metric failure without a stable metric code, reported as `internal_error`. `foreign` repeats
 * the message of a rejected foreign call or uncompilable regex; the owner abort reason uses
 * `owner_interrupted`.
 */
class MetricOperationError extends Data.TaggedError('MetricOperationError')<{
  readonly reason: 'foreign' | MetricOperationReason;
  readonly cause?: unknown;
}> {
  override readonly message =
    this.reason === 'foreign'
      ? foreignMessage(this.cause, 'Foreign operation failed.')
      : METRIC_OPERATION_MESSAGES[this.reason];
}

/** Ends one judge evaluation because its caller cancelled it. */
const judgeCancelled = (): AttestMetricError =>
  new AttestMetricError('metric_cancelled', 'Judge evaluation was cancelled.');

export { AttestMetricError, MetricOperationError, judgeCancelled, type AttestMetricErrorCode };
