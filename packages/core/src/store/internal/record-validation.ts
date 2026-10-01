import type { z } from 'zod';

import {
  caseRecordSchema,
  runRecordSchema,
  storedCaseExecutionSchema,
  storedMetricEvaluationSchema,
} from './record-schema.js';

/** Either the validated record or every structural violation, prefixed with its field path. */
type RecordParseResult<T> = { ok: true; value: T } | { ok: false; violations: string[] };

const formatPath = (prefix: string, path: readonly PropertyKey[]): string =>
  path.reduce<string>(
    (current, segment) =>
      typeof segment === 'number' ? `${current}[${segment}]` : `${current}.${String(segment)}`,
    prefix,
  );

const formatIssue = (issue: z.core.$ZodIssue, path: string): string[] => {
  const location = formatPath(path, issue.path);
  if (issue.code === 'unrecognized_keys')
    return issue.keys.map((key) => `${location} forbids ${key}`);
  return [`${location} ${issue.message}`];
};

/**
 * Persisted JSON drops undefined properties, so validation does too. Without this, strict record
 * branches would reject `{ errorCode: undefined }` on a completed case that stores identically to `{}`.
 */
const withoutUndefinedProperties = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutUndefinedProperties);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefinedProperties(entry)]),
  );
};

const parseRecord = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  path: string,
): RecordParseResult<T> => {
  const parsed = schema.safeParse(withoutUndefinedProperties(value));
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    violations: parsed.error.issues.flatMap((issue) => formatIssue(issue, path)),
  };
};

/** Validates an untrusted run header, such as one read from an imported bundle. */
const parseRunRecord = (value: unknown, path = 'run') => parseRecord(runRecordSchema, value, path);

/** Validates an untrusted case record, such as one read from an imported bundle. */
const parseCaseRecord = (value: unknown, path = 'case') =>
  parseRecord(caseRecordSchema, value, path);

/** Lists violations in a case execution so a store can reject it before opening a transaction. */
const collectStoredCaseExecutionViolations = (value: unknown, path = 'execution'): string[] => {
  const parsed = parseRecord(storedCaseExecutionSchema, value, path);
  return parsed.ok ? [] : parsed.violations;
};

/** Lists violations in a metric evaluation so a store can reject it before opening a transaction. */
const collectStoredMetricEvaluationViolations = (value: unknown, path = 'evaluation'): string[] => {
  const parsed = parseRecord(storedMetricEvaluationSchema, value, path);
  return parsed.ok ? [] : parsed.violations;
};

export {
  collectStoredCaseExecutionViolations,
  collectStoredMetricEvaluationViolations,
  parseCaseRecord,
  parseRunRecord,
  type RecordParseResult,
};
