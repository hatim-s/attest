import type { JsonValue } from '@attest/contracts';

import type { StoredMetricEvaluation } from '../store/index.js';
import type { MetricErrorInfo, MetricEvaluation } from './metric-evaluation.js';

const metricErrorCodes = new Set<string>([
  'exec_spawn_failed',
  'exec_timeout',
  'exec_nonzero_exit',
  'exec_malformed_output',
  'http_request_failed',
  'http_bad_status',
  'judge_provider_error',
  'judge_unparseable_response',
  'internal_error',
  'invalid_json_schema',
  'invalid_path',
  'skipped_no_output',
]);

/** Narrows persisted JSON blobs back to the metric contract's JSON-only evidence surface. */
const asJsonValue = (value: unknown): JsonValue | undefined => value as JsonValue | undefined;

/** Restores a typed metric code while keeping malformed legacy storage evidence actionable. */
const isMetricErrorCode = (kind: string): kind is MetricErrorInfo['code'] =>
  metricErrorCodes.has(kind);

/** Restores a typed metric code while keeping malformed legacy storage evidence actionable. */
const toMetricErrorCode = (kind: string): MetricErrorInfo['code'] =>
  isMetricErrorCode(kind) ? kind : 'internal_error';

/**
 * Flattens runtime metric evidence for the existing store boundary so the Phase 1 gate can persist it losslessly.
 */
const toStoredMetricEvaluation = (evaluation: MetricEvaluation): StoredMetricEvaluation => {
  if (evaluation.status === 'evaluated') {
    return {
      metricName: evaluation.metricName,
      kind: evaluation.kind,
      status: 'evaluated',
      score: evaluation.result.score,
      pass: evaluation.result.pass,
      ...(evaluation.result.rationale === undefined
        ? {}
        : { rationale: evaluation.result.rationale }),
      ...(evaluation.result.details === undefined ? {} : { details: evaluation.result.details }),
      ...(evaluation.judgeIo === undefined ? {} : { judgeIo: evaluation.judgeIo }),
      durationMs: evaluation.durationMs,
    };
  }

  return {
    metricName: evaluation.metricName,
    kind: evaluation.kind,
    status: 'error',
    error: { kind: evaluation.error.code, message: evaluation.error.message },
    ...(evaluation.error.details === undefined ? {} : { details: evaluation.error.details }),
    durationMs: evaluation.durationMs,
  };
};

/**
 * Rehydrates stored metric evidence at the runtime boundary, preserving status discrimination for gate consumers.
 */
const fromStoredMetricEvaluation = (stored: StoredMetricEvaluation): MetricEvaluation => {
  if (stored.status === 'evaluated') {
    return {
      metricName: stored.metricName,
      kind: stored.kind,
      status: 'evaluated',
      result: {
        score: stored.score ?? 0,
        pass: stored.pass ?? false,
        ...(stored.rationale === undefined ? {} : { rationale: stored.rationale }),
        ...(stored.details === undefined ? {} : { details: asJsonValue(stored.details) }),
      },
      ...(stored.judgeIo === undefined ? {} : { judgeIo: asJsonValue(stored.judgeIo) }),
      durationMs: stored.durationMs ?? 0,
    };
  }

  return {
    metricName: stored.metricName,
    kind: stored.kind,
    status: 'error',
    error: {
      code: toMetricErrorCode(stored.error?.kind ?? 'internal_error'),
      message: stored.error?.message ?? 'Stored metric error is missing its message.',
      ...(stored.details === undefined ? {} : { details: asJsonValue(stored.details) }),
    },
    durationMs: stored.durationMs ?? 0,
  };
};

export { fromStoredMetricEvaluation, toStoredMetricEvaluation };
