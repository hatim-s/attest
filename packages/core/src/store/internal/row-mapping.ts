import type { JsonValue } from '@attest/contracts';

import type { CasesTable, MetricResultsTable, RunsTable } from '../schema.js';
import {
  StoreError,
  type CaseRecord,
  type RunRecord,
  type RunSummary,
  type StoredAttempt,
  type StoredCaseExecution,
  type StoredDiagnostics,
  type StoredMetricEvaluation,
} from '../types.js';

const parseJson = <Value>(serialized: string | null): Value | undefined => {
  if (serialized === null) {
    return undefined;
  }

  try {
    return JSON.parse(serialized) as Value;
  } catch (error) {
    throw new StoreError('CORRUPT_DATA', 'Stored JSON could not be rehydrated.', { cause: error });
  }
};

const parseRequiredJson = <Value>(serialized: string, field: string): Value => {
  const value = parseJson<Value>(serialized);
  if (value === undefined) {
    throw new StoreError('CORRUPT_DATA', `Stored ${field} JSON is missing.`);
  }
  return value;
};

/** Restores a public run record from its initial schema row representation (PLAN 1S.3). */
const toRunRecord = (row: RunsTable): RunRecord => {
  const record: RunRecord = {
    id: row.id,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status,
    schemaId: row.schema_id,
    configHash: row.config_hash,
    configJson: row.config_json,
    gitSha: row.git_sha ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    labels: parseJson<Record<string, string>>(row.labels_json),
    summary: parseJson<RunSummary>(row.summary_json),
  };
  Object.defineProperty(record, 'configVersion', {
    configurable: true,
    get: () => record.schemaId,
  });
  return record;
};

/** Restores a metric evaluation while enforcing its persisted status discriminant. */
const toMetricEvaluation = (row: MetricResultsTable): StoredMetricEvaluation => {
  const shared = {
    metricName: row.metric_name,
    kind: row.kind,
    rationale: row.rationale ?? undefined,
    details: parseJson<JsonValue>(row.details_json),
    judgeIo: parseJson<JsonValue>(row.judge_io_json),
    durationMs: row.duration_ms ?? undefined,
  };
  if (row.status === 'evaluated') {
    if (row.score === null || (row.pass !== 0 && row.pass !== 1) || row.error_json !== null) {
      throw new StoreError('CORRUPT_DATA', 'Stored evaluated metric violates its discriminant.');
    }
    return { ...shared, status: 'evaluated', score: row.score, pass: row.pass === 1 };
  }
  if (
    row.status !== 'error' ||
    row.error_json === null ||
    row.score !== null ||
    row.pass !== null
  ) {
    throw new StoreError('CORRUPT_DATA', 'Stored errored metric violates its discriminant.');
  }
  return {
    ...shared,
    status: 'error',
    error: parseRequiredJson<Extract<StoredMetricEvaluation, { status: 'error' }>['error']>(
      row.error_json,
      'metric error',
    ),
  };
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
    request: parseRequiredJson<StoredCaseExecution['request']>(row.request_json, 'request'),
    warnings: parseRequiredJson<StoredCaseExecution['warnings']>(row.warnings_json, 'warnings'),
    diagnostics: parseRequiredJson<StoredDiagnostics>(row.diagnostics_json, 'diagnostics'),
    attempts: parseRequiredJson<StoredAttempt[]>(row.attempts_json, 'attempts'),
    expectedMetrics: parseRequiredJson<string[]>(row.expected_metrics_json, 'expected metrics'),
    metrics,
  };

  if (row.outcome === 'completed') {
    if (row.response_json === null || row.error_code !== null) {
      throw new StoreError('CORRUPT_DATA', 'Stored completed case violates its discriminant.');
    }
    return {
      ...shared,
      outcome: 'completed',
      response: parseRequiredJson(row.response_json, 'response'),
      trace: parseJson(row.trace_json),
    };
  }

  if (row.error_code === null || row.error_message === null || row.trace_json !== null) {
    throw new StoreError('CORRUPT_DATA', 'Stored failed case violates its discriminant.');
  }
  return {
    ...shared,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
};

export { parseJson, toCaseRecord, toMetricEvaluation, toRunRecord };
