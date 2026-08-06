import type { JsonValue } from '@attest/contracts';

import type { StoredMetricEvaluation } from '../store/index.js';
import type { MetricEvaluation } from './metric-evaluation.js';

/** Identifies a version mismatch at the trusted, versioned store-to-runtime boundary. */
class StoredMetricEvaluationMappingError extends Error {
  readonly code = 'INVALID_STORED_METRIC_EVALUATION';

  constructor(message: string) {
    super(message);
    this.name = 'StoredMetricEvaluationMappingError';
  }
}

/** Verifies that store evidence remains representable by the runtime's JSON-only result contract. */
const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

/** Restores JSON evidence or fails loudly rather than silently corrupting a versioned store record. */
const readJsonEvidence = (value: unknown, field: string): JsonValue => {
  if (!isJsonValue(value)) {
    throw new StoredMetricEvaluationMappingError(
      `Stored metric evaluation ${field} must be a JSON value.`,
    );
  }
  return value;
};

/** Requires a finite stored score because an evaluated result cannot be reconstructed without one. */
const readScore = (stored: StoredMetricEvaluation): number => {
  if (typeof stored.score !== 'number' || !Number.isFinite(stored.score)) {
    throw new StoredMetricEvaluationMappingError(
      'Stored evaluated metric record is missing a finite score.',
    );
  }
  return stored.score;
};

/** Requires a stored pass discriminator because score alone cannot preserve metric verdict semantics. */
const readPass = (stored: StoredMetricEvaluation): boolean => {
  if (typeof stored.pass !== 'boolean') {
    throw new StoredMetricEvaluationMappingError(
      'Stored evaluated metric record is missing its boolean pass verdict.',
    );
  }
  return stored.pass;
};

/** Requires the complete error envelope so forward-compatible failure kinds and messages remain exact. */
const readError = (stored: StoredMetricEvaluation): { kind: string; message: string } => {
  if (
    stored.error === undefined ||
    typeof stored.error.kind !== 'string' ||
    stored.error.kind.length === 0 ||
    typeof stored.error.message !== 'string' ||
    stored.error.message.length === 0
  ) {
    throw new StoredMetricEvaluationMappingError(
      'Stored error metric record is missing its error kind or message.',
    );
  }
  return stored.error;
};

/** Flattens runtime metric evidence for the existing store boundary without rewriting any evidence. */
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
      ...(evaluation.durationMs === undefined ? {} : { durationMs: evaluation.durationMs }),
    };
  }

  return {
    metricName: evaluation.metricName,
    kind: evaluation.kind,
    status: 'error',
    error: { kind: evaluation.error.code, message: evaluation.error.message },
    ...(evaluation.rationale === undefined ? {} : { rationale: evaluation.rationale }),
    ...(evaluation.error.details === undefined ? {} : { details: evaluation.error.details }),
    ...(evaluation.judgeIo === undefined ? {} : { judgeIo: evaluation.judgeIo }),
    ...(evaluation.durationMs === undefined ? {} : { durationMs: evaluation.durationMs }),
  };
};

/** Rehydrates a store record exactly; malformed versioned arms fail instead of acquiring invented defaults. */
const fromStoredMetricEvaluation = (stored: StoredMetricEvaluation): MetricEvaluation => {
  if (stored.status === 'evaluated') {
    return {
      metricName: stored.metricName,
      kind: stored.kind,
      status: 'evaluated',
      result: {
        score: readScore(stored),
        pass: readPass(stored),
        ...(stored.rationale === undefined ? {} : { rationale: stored.rationale }),
        ...(stored.details === undefined
          ? {}
          : { details: readJsonEvidence(stored.details, 'details') }),
      },
      ...(stored.judgeIo === undefined
        ? {}
        : { judgeIo: readJsonEvidence(stored.judgeIo, 'judgeIo') }),
      ...(stored.durationMs === undefined ? {} : { durationMs: stored.durationMs }),
    };
  }

  const error = readError(stored);
  return {
    metricName: stored.metricName,
    kind: stored.kind,
    status: 'error',
    error: {
      code: error.kind,
      message: error.message,
      ...(stored.details === undefined
        ? {}
        : { details: readJsonEvidence(stored.details, 'details') }),
    },
    ...(stored.rationale === undefined ? {} : { rationale: stored.rationale }),
    ...(stored.judgeIo === undefined
      ? {}
      : { judgeIo: readJsonEvidence(stored.judgeIo, 'judgeIo') }),
    ...(stored.durationMs === undefined ? {} : { durationMs: stored.durationMs }),
  };
};

export { StoredMetricEvaluationMappingError, fromStoredMetricEvaluation, toStoredMetricEvaluation };
