import { isDeepStrictEqual } from 'node:util';

import type { LeafAssertionCheck } from '@attest/contracts';

import { resolveValuePath, type EvaluationDocument } from '../evaluation-document.js';
import { evaluateJsonSchemaCheck } from './json-schema-check.js';
import type { CheckEvaluation, LeafCheck } from './leaf-check.js';
import { pathNotFound } from './path.js';
import { evaluateSpansCheck } from './span-check.js';
import { evaluateToolCallsCheck } from './tool-calls-check.js';

// Catastrophic backtracking can block the event loop, so authored patterns only run on bounded input.
const MAXIMUM_REGEX_INPUT_BYTES = 65_536;

/** Evaluates structural JSON equality so object key order does not affect spec assertion results. */
const evaluateEqualsCheck = (
  check: LeafCheck<'equals'>,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveValuePath(document, check.path);
  if (!resolution.found) {
    return pathNotFound(check.path);
  }
  if (isDeepStrictEqual(resolution.value, check.value)) {
    return { passed: true };
  }
  return { passed: false, reason: `value at ${check.path} did not equal the expected value` };
};

/** Evaluates substring or array membership while rejecting target types outside spec §Check set v0. */
const evaluateContainsCheck = (
  check: LeafCheck<'contains'>,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveValuePath(document, check.path);
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
    return resolution.value.some((value) => isDeepStrictEqual(value, check.value))
      ? { passed: true }
      : { passed: false, reason: `array at ${check.path} did not contain the expected value` };
  }

  return { passed: false, reason: `contains target at ${check.path} must be a string or array` };
};

/** Evaluates a JavaScript regex, refusing inputs past the byte cap before the pattern runs. */
const evaluateRegexCheck = (
  check: LeafCheck<'regex'>,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveValuePath(document, check.path);
  if (!resolution.found) {
    return pathNotFound(check.path);
  }
  if (typeof resolution.value !== 'string') {
    return { passed: false, reason: `regex target at ${check.path} must be a string` };
  }
  if (Buffer.byteLength(resolution.value) > MAXIMUM_REGEX_INPUT_BYTES) {
    return {
      passed: false,
      reason: `regex input at ${check.path} exceeds the ${MAXIMUM_REGEX_INPUT_BYTES}-byte limit`,
    };
  }
  if (new RegExp(check.pattern, check.flags).test(resolution.value)) {
    return { passed: true };
  }
  return { passed: false, reason: `string at ${check.path} did not match the regular expression` };
};

/** Requires a finite numeric target and applies every comparator present in the validated threshold. */
const evaluateThresholdCheck = (
  check: LeafCheck<'threshold'>,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveValuePath(document, check.path);
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
const evaluateExistsCheck = (
  check: LeafCheck<'exists'>,
  document: EvaluationDocument,
): CheckEvaluation =>
  resolveValuePath(document, check.path).found ? { passed: true } : pathNotFound(check.path);

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
      resolveValuePath(document, check.json_schema.path),
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
