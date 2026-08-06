import type { CasesTable, MetricResultsTable, RunsTable } from '../schema.js';
import { StoreError } from '../types.js';
import type {
  CaseRecord,
  RunRecord,
  RunSummary,
  StoredCaseExecution,
  StoredMetricEvaluation,
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

/** Restores a public run record from its schema-v1 row representation (PLAN 1S.3). */
const toRunRecord = (row: RunsTable): RunRecord => ({
  id: row.id,
  createdAt: row.created_at,
  finishedAt: row.finished_at ?? undefined,
  status: row.status,
  configVersion: row.config_version,
  configHash: row.config_hash,
  configJson: row.config_json,
  gitSha: row.git_sha ?? undefined,
  gitBranch: row.git_branch ?? undefined,
  labels: parseJson<Record<string, string>>(row.labels_json),
  summary: parseJson<RunSummary>(row.summary_json),
});

/** Restores a public metric evaluation from its schema-v1 row representation (PLAN 1S.3). */
const toMetricEvaluation = (row: MetricResultsTable): StoredMetricEvaluation => ({
  metricName: row.metric_name,
  kind: row.kind,
  status: row.status,
  score: row.score ?? undefined,
  pass: row.pass === null ? undefined : row.pass === 1,
  rationale: row.rationale ?? undefined,
  details: parseJson(row.details_json),
  error: parseJson<StoredMetricEvaluation['error']>(row.error_json),
  judgeIo: parseJson(row.judge_io_json),
  durationMs: row.duration_ms ?? undefined,
});

/** Restores a public case record and its joined metrics from schema-v1 rows (PLAN 1S.3). */
const toCaseRecord = (row: CasesTable, metrics: StoredMetricEvaluation[]): CaseRecord => ({
  rowId: row.id,
  runId: row.run_id,
  caseId: row.case_id,
  suiteName: row.suite_name,
  outcome: row.outcome,
  startedAt: row.started_at,
  durationMs: row.duration_ms,
  request: parseJson<StoredCaseExecution['request']>(row.request_json)!,
  response: parseJson(row.response_json),
  responseWarnings: parseJson(row.response_warnings_json),
  invocationError: parseJson(row.invocation_error_json),
  trace: parseJson(row.trace_json),
  metrics,
});

/**
 * Computes exclusive case totals using the PLAN 1S.3 verdict rule: a completed case passes only
 * when every metric is evaluated and explicitly true; non-completed outcomes are errors.
 */
const computeSummary = (
  cases: Pick<CasesTable, 'id' | 'outcome'>[],
  metrics: Pick<MetricResultsTable, 'case_row_id' | 'status' | 'pass'>[],
): RunSummary => {
  const metricsByCase = new Map<string, typeof metrics>();
  for (const metric of metrics) {
    const caseMetrics = metricsByCase.get(metric.case_row_id) ?? [];
    caseMetrics.push(metric);
    metricsByCase.set(metric.case_row_id, caseMetrics);
  }

  let passedCases = 0;
  let errorCases = 0;
  for (const caseRow of cases) {
    if (caseRow.outcome !== 'completed') {
      errorCases += 1;
      continue;
    }

    const passed = (metricsByCase.get(caseRow.id) ?? []).every(
      (metric) => metric.status === 'evaluated' && metric.pass === 1,
    );
    passedCases += passed ? 1 : 0;
  }

  return {
    totalCases: cases.length,
    passedCases,
    failedCases: cases.length - passedCases - errorCases,
    errorCases,
    metricErrorCount: metrics.filter((metric) => metric.status === 'error').length,
  };
};

export { computeSummary, toCaseRecord, toMetricEvaluation, toRunRecord };
