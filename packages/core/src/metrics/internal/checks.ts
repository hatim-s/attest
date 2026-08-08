import type { LeafAssertionCheck } from '@attest/contracts';

import { resolveDocumentPath, type EvaluationDocument } from '../evaluation-document.js';
import { isDeepEqual } from './deep-equal.js';
import { evaluateJsonSchemaCheck } from './json-schema-check.js';
import { pathNotFound } from './path.js';
import { executeGuardedRegexTest } from './regex-guard.js';
import { evaluateSpansCheck } from './span-check.js';
import { evaluateToolCallsCheck } from './tool-calls-check.js';

type CheckEvaluation = { passed: boolean; reason?: string };

type EqualsCheck = Extract<LeafAssertionCheck, { equals: unknown }>['equals'];
type ContainsCheck = Extract<LeafAssertionCheck, { contains: unknown }>['contains'];
type RegexCheck = Extract<LeafAssertionCheck, { regex: unknown }>['regex'];
type ThresholdCheck = Extract<LeafAssertionCheck, { threshold: unknown }>['threshold'];
type ExistsCheck = Extract<LeafAssertionCheck, { exists: unknown }>['exists'];

/** Evaluates structural JSON equality so object key order does not affect spec assertion results. */
const evaluateEqualsCheck = (check: EqualsCheck, document: EvaluationDocument): CheckEvaluation => {
  const resolution = resolveDocumentPath(document, check.path);
  if (!resolution.found) {
    return pathNotFound(check.path);
  }
  if (isDeepEqual(resolution.value, check.value)) {
    return { passed: true };
  }
  return { passed: false, reason: `value at ${check.path} did not equal the expected value` };
};

/** Evaluates substring or array membership while rejecting target types outside spec §Check set v0. */
const evaluateContainsCheck = (
  check: ContainsCheck,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveDocumentPath(document, check.path);
  if (!resolution.found) {
    return pathNotFound(check.path);
  }

  if (typeof resolution.value === 'string') {
    if (typeof check.value !== 'string') {
      return { passed: false, reason: `contains on string ${check.path} requires a string value` };
    }
    return resolution.value.includes(check.value)
      ? { passed: true }
      : { passed: false, reason: `string at ${check.path} did not contain the expected substring` };
  }

  if (Array.isArray(resolution.value)) {
    return resolution.value.some((value) => isDeepEqual(value, check.value))
      ? { passed: true }
      : { passed: false, reason: `array at ${check.path} did not contain the expected value` };
  }

  return { passed: false, reason: `contains target at ${check.path} must be a string or array` };
};

/** Evaluates a JavaScript regex after the deterministic pre-execution input-size guard. */
const evaluateRegexCheck = (check: RegexCheck, document: EvaluationDocument): CheckEvaluation => {
  const resolution = resolveDocumentPath(document, check.path);
  if (!resolution.found) {
    return pathNotFound(check.path);
  }
  if (typeof resolution.value !== 'string') {
    return { passed: false, reason: `regex target at ${check.path} must be a string` };
  }

  // Catastrophic backtracking can block the event loop, so authored metric patterns run behind a guard.
  const outcome = executeGuardedRegexTest({
    pattern: check.pattern,
    flags: check.flags,
    input: resolution.value,
  });
  if (outcome.kind === 'matched') {
    return { passed: true };
  }
  if (outcome.kind === 'unmatched') {
    return {
      passed: false,
      reason: `string at ${check.path} did not match the regular expression`,
    };
  }
  return {
    passed: false,
    reason: `regex input at ${check.path} exceeds the ${outcome.limitBytes}-byte limit`,
  };
};

/** Requires a finite numeric target and applies every comparator present in the validated threshold. */
const evaluateThresholdCheck = (
  check: ThresholdCheck,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveDocumentPath(document, check.path);
  if (!resolution.found) {
    return pathNotFound(check.path);
  }
  if (typeof resolution.value !== 'number' || !Number.isFinite(resolution.value)) {
    return { passed: false, reason: `threshold target at ${check.path} must be a finite number` };
  }

  const value = resolution.value;
  const comparisonsHold =
    (check.lt === undefined || value < check.lt) &&
    (check.lte === undefined || value <= check.lte) &&
    (check.gt === undefined || value > check.gt) &&
    (check.gte === undefined || value >= check.gte);
  return comparisonsHold
    ? { passed: true }
    : {
        passed: false,
        reason: `value at ${check.path} did not satisfy every threshold comparator`,
      };
};

/** Tests path presence directly so null and false remain valid, present values under spec §Paths. */
const evaluateExistsCheck = (check: ExistsCheck, document: EvaluationDocument): CheckEvaluation => {
  return resolveDocumentPath(document, check.path).found
    ? { passed: true }
    : pathNotFound(check.path);
};

/** Flatly dispatches validated leaf checks so expected assertion failures always remain data. */
const evaluateLeafCheck = (
  check: LeafAssertionCheck,
  document: EvaluationDocument,
): CheckEvaluation => {
  if ('equals' in check) {
    return evaluateEqualsCheck(check.equals, document);
  }
  if ('contains' in check) {
    return evaluateContainsCheck(check.contains, document);
  }
  if ('regex' in check) {
    return evaluateRegexCheck(check.regex, document);
  }
  if ('json_schema' in check) {
    return evaluateJsonSchemaCheck(
      check.json_schema,
      resolveDocumentPath(document, check.json_schema.path),
    );
  }
  if ('threshold' in check) {
    return evaluateThresholdCheck(check.threshold, document);
  }
  if ('exists' in check) {
    return evaluateExistsCheck(check.exists, document);
  }
  if ('tool_calls' in check) {
    return evaluateToolCallsCheck(check.tool_calls, document.trace);
  }
  return evaluateSpansCheck(check.spans, document.trace);
};

export { evaluateLeafCheck };
