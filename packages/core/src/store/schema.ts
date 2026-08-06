/** Kysely row shape for the schema-v1 runs table (PLAN 1S.2). */
interface RunsTable {
  id: string;
  created_at: string;
  finished_at: string | null;
  status: RunStatus;
  config_version: string;
  config_hash: string;
  config_json: string;
  git_sha: string | null;
  git_branch: string | null;
  labels_json: string | null;
  summary_json: string | null;
}

/** Kysely row shape for the schema-v1 cases table (PLAN 1S.2). */
interface CasesTable {
  id: string;
  run_id: string;
  case_id: string;
  suite_name: string;
  outcome: CaseOutcome;
  started_at: string;
  duration_ms: number;
  input_hash: string;
  request_json: string;
  response_json: string | null;
  response_warnings_json: string | null;
  invocation_error_json: string | null;
  trace_json: string | null;
}

/** Kysely row shape for the schema-v1 metric_results table (PLAN 1S.2). */
interface MetricResultsTable {
  id: string;
  case_row_id: string;
  metric_name: string;
  kind: StoredMetricEvaluation['kind'];
  status: StoredMetricEvaluation['status'];
  score: number | null;
  pass: number | null;
  rationale: string | null;
  details_json: string | null;
  error_json: string | null;
  judge_io_json: string | null;
  duration_ms: number | null;
}

/** Kysely row shape for the schema-v1 spans table (PLAN 1S.2). */
interface SpansTable {
  id: string;
  case_row_id: string;
  span_id: string;
  parent_span_id: string | null;
  kind: SpanKind;
  name: string;
  start_time: string;
  end_time: string;
  status: string | null;
  tool_name: string | null;
  model_name: string | null;
}

/** Kysely row shape for the schema-v1 response_cache table (PLAN 1S.2). */
interface ResponseCacheTable {
  cache_key: string;
  kind: 'agent' | 'judge';
  payload_json: string;
  created_at: string;
  last_used_at: string;
}

/** Defines the complete schema-v1 database surface consumed by Kysely (PLAN 1S.2). */
interface Database {
  runs: RunsTable;
  cases: CasesTable;
  metric_results: MetricResultsTable;
  spans: SpansTable;
  response_cache: ResponseCacheTable;
}

export {
  type CasesTable,
  type Database,
  type MetricResultsTable,
  type ResponseCacheTable,
  type RunsTable,
  type SpansTable,
};
import type { SpanKind } from '@attest/contracts';

import type { CaseOutcome, RunStatus, StoredMetricEvaluation } from './types.js';
