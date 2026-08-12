import type { z } from 'zod';

import type { CaseRecord, RunRecord } from '../types.js';
import {
  caseRecordSchema,
  runRecordSchema,
  storedCaseExecutionSchema,
  storedMetricEvaluationSchema,
} from './record-schema.js';

const formatPath = (prefix: string, path: readonly PropertyKey[]): string =>
  path.reduce<string>(
    (current, segment) =>
      typeof segment === 'number' ? `${current}[${segment}]` : `${current}.${String(segment)}`,
    prefix,
  );

const collectViolations = (schema: z.ZodType, value: unknown, path: string): string[] => {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${formatPath(path, issue.path)} ${issue.message}`);
};

/** Collects complete structural violations in one persisted execution. */
const collectStoredCaseExecutionViolations = (value: unknown, path = 'execution'): string[] =>
  collectViolations(storedCaseExecutionSchema, value, path);

/** Collects complete structural violations in one persisted metric evaluation. */
const collectStoredMetricEvaluationViolations = (value: unknown, path = 'evaluation'): string[] =>
  collectViolations(storedMetricEvaluationSchema, value, path);

/** Collects complete case-record violations for persistence and bundle trust seams. */
const collectCaseRecordViolations = (value: unknown, path = 'case'): string[] =>
  collectViolations(caseRecordSchema, value, path);

/** Collects complete run-header violations, including lifecycle timestamp consistency. */
const collectRunRecordViolations = (value: unknown, path = 'run'): string[] =>
  collectViolations(runRecordSchema, value, path);

const isCaseRecord = (value: unknown): value is CaseRecord =>
  caseRecordSchema.safeParse(value).success;
const isRunRecord = (value: unknown): value is RunRecord =>
  runRecordSchema.safeParse(value).success;

export {
  collectCaseRecordViolations,
  collectRunRecordViolations,
  collectStoredCaseExecutionViolations,
  collectStoredMetricEvaluationViolations,
  isCaseRecord,
  isRunRecord,
};
