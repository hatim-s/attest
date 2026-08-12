import type { StoredMetricEvaluation } from '../store/index.js';
import type { MetricEvaluation } from './metric-evaluation.js';

/** Flattens runtime metric evidence into the schema-validated persisted representation. */
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

export { toStoredMetricEvaluation };
