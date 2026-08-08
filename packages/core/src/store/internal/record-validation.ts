import { agentRequestSchema, traceSchema } from '@attest/contracts';

import type { CaseRecord, RunRecord } from '../types.js';

type JsonObject = Record<string, unknown>;

const invocationErrorCodes = new Set([
  'spawn_failed',
  'timeout',
  'output_cap_exceeded',
  'nonzero_exit',
  'http_status',
  'network',
  'invalid_envelope',
  'cancelled',
]);
const runStatuses = new Set(['running', 'completed', 'failed', 'cancelled']);
const metricKinds = new Set(['assertion', 'exec', 'judge']);

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const isNonnegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Appends field-level diagnostic violations without discarding sibling failures. */
const collectDiagnosticsViolations = (value: unknown, path: string, violations: string[]): void => {
  if (!isObject(value)) {
    violations.push(`${path} must be an object`);
    return;
  }
  if (value.stderrExcerpt !== undefined && typeof value.stderrExcerpt !== 'string') {
    violations.push(`${path}.stderrExcerpt must be a string`);
  }
  if (
    value.exitCode !== undefined &&
    (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode))
  ) {
    violations.push(`${path}.exitCode must be an integer`);
  }
  if (
    value.httpStatus !== undefined &&
    (typeof value.httpStatus !== 'number' || !Number.isInteger(value.httpStatus))
  ) {
    violations.push(`${path}.httpStatus must be an integer`);
  }
  if (
    value.remoteJobId !== undefined &&
    typeof value.remoteJobId !== 'string' &&
    (typeof value.remoteJobId !== 'number' || !Number.isFinite(value.remoteJobId))
  ) {
    violations.push(`${path}.remoteJobId must be a string or finite number`);
  }
  if (
    value.unreapedProcessIds !== undefined &&
    (!Array.isArray(value.unreapedProcessIds) ||
      !value.unreapedProcessIds.every(
        (processId) => Number.isSafeInteger(processId) && processId > 0,
      ))
  ) {
    violations.push(`${path}.unreapedProcessIds must contain positive safe integers`);
  }
};

/** Collects every structural violation in one stored execution union value. */
const collectStoredCaseExecutionViolations = (value: unknown, path = 'execution'): string[] => {
  const violations: string[] = [];
  if (!isObject(value)) return [`${path} must be an object`];

  if (!isNonemptyString(value.caseId)) violations.push(`${path}.caseId must be a nonempty string`);
  if (!isNonemptyString(value.suiteName)) {
    violations.push(`${path}.suiteName must be a nonempty string`);
  }
  if (!isIsoTimestamp(value.startedAt))
    violations.push(`${path}.startedAt must be an ISO timestamp`);
  if (!isNonnegativeFiniteNumber(value.durationMs)) {
    violations.push(`${path}.durationMs must be a nonnegative finite number`);
  }
  if (!agentRequestSchema.safeParse(value.request).success) {
    violations.push(`${path}.request must be a valid agent request`);
  }

  if (!Array.isArray(value.warnings)) {
    violations.push(`${path}.warnings must be an array`);
  } else {
    value.warnings.forEach((warning, index) => {
      if (
        !isObject(warning) ||
        typeof warning.path !== 'string' ||
        typeof warning.message !== 'string' ||
        !['unknown_field', 'invalid_trace'].includes(String(warning.code))
      ) {
        violations.push(`${path}.warnings[${index}] must be a valid contract warning`);
      }
    });
  }
  collectDiagnosticsViolations(value.diagnostics, `${path}.diagnostics`, violations);

  if (!Array.isArray(value.attempts)) {
    violations.push(`${path}.attempts must be an array`);
  } else {
    value.attempts.forEach((attempt, index) => {
      const attemptPath = `${path}.attempts[${index}]`;
      if (!isObject(attempt)) {
        violations.push(`${attemptPath} must be an object`);
        return;
      }
      if (!isNonnegativeFiniteNumber(attempt.durationMs)) {
        violations.push(`${attemptPath}.durationMs must be a nonnegative finite number`);
      }
      collectDiagnosticsViolations(attempt.diagnostics, `${attemptPath}.diagnostics`, violations);
      if (!Array.isArray(attempt.warnings)) {
        violations.push(`${attemptPath}.warnings must be an array`);
      }
      if (attempt.status === 'ok') {
        if (Object.hasOwn(attempt, 'errorCode')) {
          violations.push(`${attemptPath} with ok status forbids errorCode`);
        }
        if (Object.hasOwn(attempt, 'errorMessage')) {
          violations.push(`${attemptPath} with ok status forbids errorMessage`);
        }
      } else if (attempt.status === 'invocation_error') {
        if (!invocationErrorCodes.has(String(attempt.errorCode))) {
          violations.push(`${attemptPath} requires a valid errorCode`);
        }
        if (typeof attempt.errorMessage !== 'string') {
          violations.push(`${attemptPath} requires an errorMessage string`);
        }
      } else {
        violations.push(`${attemptPath}.status must be ok or invocation_error`);
      }
    });
  }

  if (!Array.isArray(value.expectedMetrics)) {
    violations.push(`${path}.expectedMetrics must be an array`);
  } else {
    value.expectedMetrics.forEach((metricName, index) => {
      if (typeof metricName !== 'string') {
        violations.push(`${path}.expectedMetrics[${index}] must be a string`);
      }
    });
  }

  if (value.outcome === 'completed') {
    if (!Object.hasOwn(value, 'response') || value.response === undefined) {
      violations.push(`${path} with completed outcome requires response`);
    }
    if (Object.hasOwn(value, 'errorCode')) {
      violations.push(`${path} with completed outcome forbids errorCode`);
    }
    if (Object.hasOwn(value, 'errorMessage')) {
      violations.push(`${path} with completed outcome forbids errorMessage`);
    }
    if (value.trace !== undefined && !traceSchema.safeParse(value.trace).success) {
      violations.push(`${path}.trace must be a valid trace`);
    }
  } else if (['invocation_error', 'timeout', 'cancelled'].includes(String(value.outcome))) {
    if (!invocationErrorCodes.has(String(value.errorCode))) {
      violations.push(`${path} with non-completed outcome requires a valid errorCode`);
    }
    if (typeof value.errorMessage !== 'string') {
      violations.push(`${path} with non-completed outcome requires an errorMessage string`);
    }
    if (Object.hasOwn(value, 'response')) {
      violations.push(`${path} with non-completed outcome forbids response`);
    }
    if (Object.hasOwn(value, 'trace')) {
      violations.push(`${path} with non-completed outcome forbids trace`);
    }
  } else {
    violations.push(`${path}.outcome must be a supported terminal discriminant`);
  }
  return violations;
};

/** Collects every structural violation in one stored metric evaluation union value. */
const collectStoredMetricEvaluationViolations = (value: unknown, path = 'evaluation'): string[] => {
  const violations: string[] = [];
  if (!isObject(value)) return [`${path} must be an object`];

  if (!isNonemptyString(value.metricName)) {
    violations.push(`${path}.metricName must be a nonempty string`);
  }
  if (!metricKinds.has(String(value.kind))) {
    violations.push(`${path}.kind must be assertion, exec, or judge`);
  }
  if (value.rationale !== undefined && typeof value.rationale !== 'string') {
    violations.push(`${path}.rationale must be a string`);
  }
  if (value.durationMs !== undefined && !isNonnegativeFiniteNumber(value.durationMs)) {
    violations.push(`${path}.durationMs must be a nonnegative finite number`);
  }

  if (value.status === 'evaluated') {
    if (typeof value.score !== 'number' || !Number.isFinite(value.score)) {
      violations.push(`${path} with evaluated status requires a finite score`);
    }
    if (typeof value.pass !== 'boolean') {
      violations.push(`${path} with evaluated status requires a boolean pass`);
    }
    if (Object.hasOwn(value, 'error')) {
      violations.push(`${path} with evaluated status forbids error`);
    }
  } else if (value.status === 'error') {
    if (
      !isObject(value.error) ||
      !isNonemptyString(value.error.message) ||
      !isNonemptyString(value.error.kind)
    ) {
      violations.push(`${path} with error status requires an error object`);
    }
    if (Object.hasOwn(value, 'score')) {
      violations.push(`${path} with error status forbids score`);
    }
    if (Object.hasOwn(value, 'pass')) {
      violations.push(`${path} with error status forbids pass`);
    }
  } else {
    violations.push(`${path}.status must be evaluated or error`);
  }
  return violations;
};

/** Collects complete case-record violations for persistence and bundle trust boundaries. */
const collectCaseRecordViolations = (value: unknown, path = 'case'): string[] => {
  if (!isObject(value)) return [`${path} must be an object`];
  const violations = collectStoredCaseExecutionViolations(value, path);
  if (!isNonemptyString(value.rowId)) violations.push(`${path}.rowId must be a nonempty string`);
  if (!isNonemptyString(value.runId)) violations.push(`${path}.runId must be a nonempty string`);
  if (!isNonemptyString(value.inputHash)) {
    violations.push(`${path}.inputHash must be a nonempty string`);
  }
  if (!Array.isArray(value.metrics)) {
    violations.push(`${path}.metrics must be an array`);
  } else {
    value.metrics.forEach((metric, index) => {
      violations.push(
        ...collectStoredMetricEvaluationViolations(metric, `${path}.metrics[${index}]`),
      );
    });
  }
  return violations;
};

/** Collects complete run-header violations, including lifecycle timestamp consistency. */
const collectRunRecordViolations = (value: unknown, path = 'run'): string[] => {
  const violations: string[] = [];
  if (!isObject(value)) return [`${path} must be an object`];
  if (!isNonemptyString(value.id)) violations.push(`${path}.id must be a nonempty string`);
  if (!isIsoTimestamp(value.createdAt))
    violations.push(`${path}.createdAt must be an ISO timestamp`);
  if (!runStatuses.has(String(value.status))) violations.push(`${path}.status is invalid`);
  if (!isNonemptyString(value.configVersion)) {
    violations.push(`${path}.configVersion must be a nonempty string`);
  }
  if (!isNonemptyString(value.configHash)) {
    violations.push(`${path}.configHash must be a nonempty string`);
  }
  if (typeof value.configJson !== 'string') violations.push(`${path}.configJson must be a string`);
  if (value.gitSha !== undefined && typeof value.gitSha !== 'string') {
    violations.push(`${path}.gitSha must be a string`);
  }
  if (value.gitBranch !== undefined && typeof value.gitBranch !== 'string') {
    violations.push(`${path}.gitBranch must be a string`);
  }
  if (
    value.labels !== undefined &&
    (!isObject(value.labels) ||
      !Object.values(value.labels).every((label) => typeof label === 'string'))
  ) {
    violations.push(`${path}.labels must contain only string values`);
  }
  if (value.status === 'running') {
    if (Object.hasOwn(value, 'finishedAt'))
      violations.push(`${path} running status forbids finishedAt`);
  } else if (runStatuses.has(String(value.status)) && !isIsoTimestamp(value.finishedAt)) {
    violations.push(`${path} terminal status requires an ISO finishedAt timestamp`);
  }
  if (value.summary !== undefined) {
    const summary = value.summary;
    const fields = ['totalCases', 'passedCases', 'failedCases', 'errorCases', 'metricErrorCount'];
    if (
      !isObject(summary) ||
      fields.some((field) => !Number.isInteger(summary[field]) || Number(summary[field]) < 0)
    ) {
      violations.push(`${path}.summary must contain nonnegative integer counts`);
    }
  }
  return violations;
};

const isCaseRecord = (value: unknown): value is CaseRecord =>
  collectCaseRecordViolations(value).length === 0;

const isRunRecord = (value: unknown): value is RunRecord =>
  collectRunRecordViolations(value).length === 0;

export {
  collectCaseRecordViolations,
  collectRunRecordViolations,
  collectStoredCaseExecutionViolations,
  collectStoredMetricEvaluationViolations,
  isCaseRecord,
  isRunRecord,
};
