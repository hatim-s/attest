import { z } from 'zod';
import type { JsonValue } from '@attest/contracts';
import {
  StoreError,
  runRecordSchema,
  caseRecordSchema,
  storedMetricEvaluationSchema,
  type CaseRecord,
  type RunRecord,
  type RunSummary,
  type StoredMetricEvaluation,
} from '@attest/core';

import type { CasesTable, MetricResultsTable, RunsTable } from '../schema.js';

// BOUNDARY: Rehydrated SQL JSON is checked against its complete owner record schema.
const parseStored = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success)
    throw new StoreError('CORRUPT_DATA', 'Stored record violates its schema.', {
      cause: parsed.error,
    });

  return parsed.data;
};

const parseJson = (serialized: string | null): JsonValue | undefined => {
  if (serialized === null) {
    return undefined;
  }

  try {
    return z.json().parse(JSON.parse(serialized));
  } catch (error) {
    throw new StoreError('CORRUPT_DATA', 'Stored JSON could not be rehydrated.', { cause: error });
  }
};

const parseRequiredJson = (serialized: string, field: string): JsonValue => {
  const value = parseJson(serialized);

  if (value === undefined) {
    throw new StoreError('CORRUPT_DATA', `Stored ${field} JSON is missing.`);
  }

  return value;
};

/** Restores a public run record from its row and the totals its caller computed. */
const toRunRecord = (row: RunsTable, summary: RunSummary | undefined): RunRecord =>
  parseStored(runRecordSchema, {
    id: row.id,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status,
    schemaId: row.schema_id,
    configHash: row.config_hash,
    configJson: row.config_json,
    gitSha: row.git_sha ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    labels: parseJson(row.labels_json),
    summary,
  });

/** Restores a metric evaluation while enforcing its persisted status discriminant. */
type MetricResultRow = Omit<MetricResultsTable, 'status'> & { status: string };

const toMetricEvaluation = (row: MetricResultRow): StoredMetricEvaluation => {
  const shared = {
    metricName: row.metric_name,
    kind: row.kind,
    rationale: row.rationale ?? undefined,
    details: parseJson(row.details_json),
    judgeIo: parseJson(row.judge_io_json),
    durationMs: row.duration_ms ?? undefined,
  };

  if (row.status === 'evaluated') {
    if (row.score === null || (row.pass !== 0 && row.pass !== 1) || row.error_json !== null) {
      throw new StoreError('CORRUPT_DATA', 'Stored evaluated metric violates its discriminant.');
    }

    return parseStored(storedMetricEvaluationSchema, {
      ...shared,
      status: 'evaluated',
      score: row.score,
      pass: row.pass === 1,
    });
  }

  if (
    row.status !== 'error' ||
    row.error_json === null ||
    row.score !== null ||
    row.pass !== null
  ) {
    throw new StoreError('CORRUPT_DATA', 'Stored errored metric violates its discriminant.');
  }

  return parseStored(storedMetricEvaluationSchema, {
    ...shared,
    status: 'error',
    error: parseRequiredJson(row.error_json, 'metric error'),
  });
};

/** Restores a discriminated public case and its metric evidence from initial schema rows. */
const toCaseRecord = (row: CasesTable, metrics: StoredMetricEvaluation[]): CaseRecord => {
  const shared = {
    rowId: row.id,
    runId: row.run_id,
    inputHash: row.input_hash,
    caseId: row.case_id,
    suiteName: row.suite_name,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    request: parseRequiredJson(row.request_json, 'request'),
    warnings: parseRequiredJson(row.warnings_json, 'warnings'),
    diagnostics: parseRequiredJson(row.diagnostics_json, 'diagnostics'),
    attempts: parseRequiredJson(row.attempts_json, 'attempts'),
    expectedMetrics: parseRequiredJson(row.expected_metrics_json, 'expected metrics'),
    metrics,
  };

  if (row.outcome === 'completed') {
    if (row.response_json === null || row.error_code !== null) {
      throw new StoreError('CORRUPT_DATA', 'Stored completed case violates its discriminant.');
    }

    return parseStored(caseRecordSchema, {
      ...shared,
      outcome: 'completed',
      response: parseRequiredJson(row.response_json, 'response'),
      trace: parseJson(row.trace_json),
    });
  }

  if (row.error_code === null || row.error_message === null || row.trace_json !== null) {
    throw new StoreError('CORRUPT_DATA', 'Stored failed case violates its discriminant.');
  }

  return parseStored(caseRecordSchema, {
    ...shared,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  });
};

export { parseJson, toCaseRecord, toMetricEvaluation, toRunRecord };
