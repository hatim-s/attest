import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import type { LeafAssertionCheck } from '@attest/contracts';

import { resolveDocumentPath, type EvaluationDocument } from '../evaluation-document.js';
import { executeGuardedRegexTest } from './regex-guard.js';

type CheckEvaluation = { passed: boolean; reason?: string };

type EqualsCheck = Extract<LeafAssertionCheck, { equals: unknown }>['equals'];
type ContainsCheck = Extract<LeafAssertionCheck, { contains: unknown }>['contains'];
type RegexCheck = Extract<LeafAssertionCheck, { regex: unknown }>['regex'];
type JsonSchemaCheck = Extract<LeafAssertionCheck, { json_schema: unknown }>['json_schema'];
type ThresholdCheck = Extract<LeafAssertionCheck, { threshold: unknown }>['threshold'];
type ExistsCheck = Extract<LeafAssertionCheck, { exists: unknown }>['exists'];
type ToolCallsCheck = Extract<LeafAssertionCheck, { tool_calls: unknown }>['tool_calls'];

const ajv = new Ajv2020.Ajv2020({ allErrors: true, strict: false });
const objectSchemaValidators = new WeakMap<object, ValidateFunction>();
const booleanSchemaValidators = new Map<boolean, ValidateFunction>();

const isDeepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => isDeepEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && isDeepEqual(leftRecord[key], rightRecord[key]),
    )
  );
};

const resolveCheckValue = (
  document: EvaluationDocument,
  path: string,
): { found: true; value: unknown } | CheckEvaluation => {
  const resolution = resolveDocumentPath(document, path);
  if (!resolution.found) {
    return { passed: false, reason: `path ${path} was not found` };
  }
  return resolution;
};

/** Evaluates structural JSON equality so object key order does not affect spec assertion results. */
const evaluateEqualsCheck = (check: EqualsCheck, document: EvaluationDocument): CheckEvaluation => {
  const resolution = resolveCheckValue(document, check.path);
  if (!('found' in resolution)) {
    return resolution;
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
  const resolution = resolveCheckValue(document, check.path);
  if (!('found' in resolution)) {
    return resolution;
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

  return {
    passed: false,
    reason: `contains target at ${check.path} must be a string or array`,
  };
};

/** Applies the isolated regex guard and keeps size or time overruns as deterministic assertion failures. */
const evaluateRegexCheck = (check: RegexCheck, document: EvaluationDocument): CheckEvaluation => {
  const resolution = resolveCheckValue(document, check.path);
  if (!('found' in resolution)) {
    return resolution;
  }
  if (typeof resolution.value !== 'string') {
    return { passed: false, reason: `regex target at ${check.path} must be a string` };
  }

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
  if (outcome.kind === 'input_too_large') {
    return {
      passed: false,
      reason: `regex input at ${check.path} exceeds the ${outcome.limitBytes}-byte limit`,
    };
  }
  return {
    passed: false,
    reason: `regex at ${check.path} exceeded the ${outcome.budgetMs}ms budget`,
  };
};

const getSchemaValidator = (schema: JsonSchemaCheck['schema']): ValidateFunction => {
  if (typeof schema === 'boolean') {
    const cached = booleanSchemaValidators.get(schema);
    if (cached !== undefined) {
      return cached;
    }
    const validator = ajv.compile(schema);
    booleanSchemaValidators.set(schema, validator);
    return validator;
  }

  const cached = objectSchemaValidators.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const validator = ajv.compile(schema as AnySchema);
  objectSchemaValidators.set(schema, validator);
  return validator;
};

/** Validates Draft 2020-12 schemas and exposes Ajv diagnostics as actionable assertion evidence. */
const evaluateJsonSchemaCheck = (
  check: JsonSchemaCheck,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveCheckValue(document, check.path);
  if (!('found' in resolution)) {
    return resolution;
  }

  let validator: ValidateFunction;
  try {
    validator = getSchemaValidator(check.schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      reason: `JSON Schema at ${check.path} could not be compiled: ${message}`,
    };
  }
  if ('$async' in validator && validator.$async === true) {
    return {
      passed: false,
      reason: `JSON Schema at ${check.path} must be synchronous`,
    };
  }
  if (validator(resolution.value)) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: `value at ${check.path} failed JSON Schema validation: ${ajv.errorsText(validator.errors, { separator: '; ' })}`,
  };
};

/** Requires a finite numeric target and applies every comparator present in the validated threshold. */
const evaluateThresholdCheck = (
  check: ThresholdCheck,
  document: EvaluationDocument,
): CheckEvaluation => {
  const resolution = resolveCheckValue(document, check.path);
  if (!('found' in resolution)) {
    return resolution;
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
  if (resolveDocumentPath(document, check.path).found) {
    return { passed: true };
  }
  return { passed: false, reason: `path ${check.path} was not found` };
};

/** Evaluates v0 tool span name, status, count, and chronological order without treating no trace as an error. */
const evaluateToolCallsCheck = (
  check: ToolCallsCheck,
  document: EvaluationDocument,
): CheckEvaluation => {
  if (document.trace === null) {
    return { passed: false, reason: 'no trace emitted' };
  }

  const chronologicalTools = [...document.trace.spans]
    .filter((span) => span.kind === 'tool')
    .sort((left, right) => left.start_time.localeCompare(right.start_time));
  const candidates =
    check.name === undefined
      ? chronologicalTools
      : chronologicalTools.filter((span) => span.name === check.name);
  const hasOnlyNameFilter =
    check.name !== undefined &&
    check.status === undefined &&
    check.count === undefined &&
    check.order === undefined;

  if (candidates.length === 0 && hasOnlyNameFilter) {
    return { passed: false, reason: `tool never called: ${check.name}` };
  }
  if (check.status !== undefined && candidates.some((span) => span.status.code !== check.status)) {
    return { passed: false, reason: `not every matching tool call had status ${check.status}` };
  }
  if (check.count !== undefined && candidates.length !== check.count) {
    return {
      passed: false,
      reason: `expected ${check.count} matching tool calls but found ${candidates.length}`,
    };
  }
  if (
    check.order !== undefined &&
    !isDeepEqual(
      candidates.map((span) => span.name),
      check.order,
    )
  ) {
    return { passed: false, reason: 'tool call order did not match the expected sequence' };
  }

  return { passed: true };
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
    return evaluateJsonSchemaCheck(check.json_schema, document);
  }
  if ('threshold' in check) {
    return evaluateThresholdCheck(check.threshold, document);
  }
  if ('exists' in check) {
    return evaluateExistsCheck(check.exists, document);
  }
  return evaluateToolCallsCheck(check.tool_calls, document);
};

export { evaluateLeafCheck };
