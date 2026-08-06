import { AttestError } from '@attest/contracts';

import type { CaseRecord } from '../store/types.js';
import type { CiVerdict, RunDiff, ThresholdConfig } from './types.js';

/** Identifies invalid CI threshold configuration before any gate is evaluated. */
class DiffConfigError extends AttestError {
  readonly code = 'INVALID_THRESHOLD';

  constructor(message: string) {
    super('INVALID_THRESHOLD', message);
    this.name = 'DiffConfigError';
  }
}

/** Rejects threshold values whose comparisons would be misleading or silently disabled. */
const validateThresholds = (thresholds: ThresholdConfig): void => {
  if (
    thresholds.minPassRate !== undefined &&
    (!Number.isFinite(thresholds.minPassRate) ||
      thresholds.minPassRate < 0 ||
      thresholds.minPassRate > 1)
  ) {
    throw new DiffConfigError(
      `minPassRate must be a finite number in [0, 1], received ${thresholds.minPassRate}`,
    );
  }
  if (
    thresholds.maxRegressions !== undefined &&
    (!Number.isFinite(thresholds.maxRegressions) ||
      !Number.isInteger(thresholds.maxRegressions) ||
      thresholds.maxRegressions < 0)
  ) {
    throw new DiffConfigError(
      `maxRegressions must be a nonnegative integer, received ${thresholds.maxRegressions}`,
    );
  }
};

/** Evaluates only explicitly configured PLAN 1D.3 CI gates. */
const evaluateThresholds = (
  diff: RunDiff,
  candidateCases: CaseRecord[],
  thresholds: ThresholdConfig,
): CiVerdict => {
  validateThresholds(thresholds);
  const reasons: string[] = [];
  if (
    thresholds.minPassRate !== undefined &&
    diff.summary.candidatePassRate < thresholds.minPassRate
  ) {
    reasons.push(
      `pass rate ${diff.summary.candidatePassRate} below minimum ${thresholds.minPassRate}`,
    );
  }

  const regressionCount = diff.transitions.filter(
    (transition) => transition.baseVerdict === 'pass' && transition.candidateVerdict !== 'pass',
  ).length;
  if (thresholds.maxRegressions !== undefined && regressionCount > thresholds.maxRegressions) {
    reasons.push(
      `${regressionCount} base-pass to candidate-nonpass transitions exceed maximum ${thresholds.maxRegressions}`,
    );
  }

  if (thresholds.failOnInvocationErrors) {
    const invocationErrorCount = candidateCases.filter(
      (caseRecord) => caseRecord.outcome !== 'completed',
    ).length;
    if (invocationErrorCount > 0) {
      reasons.push(`${invocationErrorCount} invocation errors in candidate run`);
    }
  }

  if (thresholds.failOnMetricErrors) {
    const metricErrorCount = candidateCases.reduce(
      (count, caseRecord) =>
        count + caseRecord.metrics.filter((metric) => metric.status === 'error').length,
      0,
    );
    if (metricErrorCount > 0) {
      reasons.push(`${metricErrorCount} metric errors in candidate run`);
    }
  }

  const pass = reasons.length === 0;
  return { pass, exitCode: pass ? 0 : 1, reasons };
};

export { DiffConfigError, evaluateThresholds };
