import type { AssertionCheck, JsonValue, MetricDefinition, MetricResult } from '@attest/contracts';

import type { EvaluationDocument } from './evaluation-document.js';
import { evaluateLeafCheck } from './internal/checks.js';

/** Narrows the shared metric contract to the deterministic assertion definition used by this engine. */
type AssertionMetricDefinition = Extract<MetricDefinition, { type: 'assertion' }>;

/** Retains the source check beside its verdict so callers can render precise assertion evidence. */
type AssertionCheckOutcome = { check: AssertionCheck; passed: boolean; reason?: string };

/** Couples the normalized spec result with full check outcomes for richer internal consumers. */
type AssertionMetricOutcome = { result: MetricResult; outcomes: AssertionCheckOutcome[] };

const aggregateFailureReasons = (
  combinator: 'all' | 'any',
  outcomes: AssertionCheckOutcome[],
): string => {
  const reasons = outcomes
    .map((outcome, index) =>
      outcome.passed ? undefined : `${index + 1}: ${outcome.reason ?? 'failed'}`,
    )
    .filter((reason): reason is string => reason !== undefined);
  return `${combinator} failed (${reasons.join('; ')})`;
};

/** Purely composes spec checks: all requires every child, any requires one, and not inverts its child. */
const evaluateAssertionCheck = (
  check: AssertionCheck,
  document: EvaluationDocument,
): AssertionCheckOutcome => {
  if ('all' in check) {
    const outcomes = check.all.map((child) => evaluateAssertionCheck(child, document));
    const passed = outcomes.every((outcome) => outcome.passed);
    return passed
      ? { check, passed: true }
      : { check, passed: false, reason: aggregateFailureReasons('all', outcomes) };
  }

  if ('any' in check) {
    const outcomes = check.any.map((child) => evaluateAssertionCheck(child, document));
    const passed = outcomes.some((outcome) => outcome.passed);
    return passed
      ? { check, passed: true }
      : { check, passed: false, reason: aggregateFailureReasons('any', outcomes) };
  }

  if ('not' in check) {
    const outcome = evaluateAssertionCheck(check.not, document);
    return outcome.passed
      ? { check, passed: false, reason: 'not failed because its child passed' }
      : { check, passed: true };
  }

  const outcome = evaluateLeafCheck(check, document);
  return outcome.reason === undefined
    ? { check, passed: outcome.passed }
    : { check, passed: outcome.passed, reason: outcome.reason };
};

/** Computes the spec §Assertions fraction and aligned details while requiring every top-level check to pass. */
const evaluateAssertionMetric = (
  definition: AssertionMetricDefinition,
  document: EvaluationDocument,
): AssertionMetricOutcome => {
  const outcomes = definition.assert.map((check) => evaluateAssertionCheck(check, document));
  const passedCount = outcomes.filter((outcome) => outcome.passed).length;
  const checks = outcomes.map<JsonValue>((outcome) => {
    const details: Record<string, JsonValue> = { passed: outcome.passed };
    if (outcome.reason !== undefined) {
      details.reason = outcome.reason;
    }
    return details;
  });
  const result: MetricResult = {
    score: passedCount / outcomes.length,
    pass: passedCount === outcomes.length,
    details: { checks },
  };

  return { result, outcomes };
};

export {
  evaluateAssertionCheck,
  evaluateAssertionMetric,
  type AssertionCheckOutcome,
  type AssertionMetricDefinition,
  type AssertionMetricOutcome,
};
