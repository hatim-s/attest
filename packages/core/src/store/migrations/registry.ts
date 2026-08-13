/** Emitted initial schema asset; migrations/0001_initial.sql is its reviewable mirror. */
const initialSchemaSql = `-- mirrored in registry.ts — update both
-- This initial schema is the only supported database layout.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  schema_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  git_sha TEXT,
  git_branch TEXT,
  labels_json TEXT,
  summary_json TEXT
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'invocation_error', 'timeout', 'cancelled')),
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  input_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  error_code TEXT CHECK (error_code IN ('spawn_failed', 'timeout', 'output_cap_exceeded', 'nonzero_exit', 'http_status', 'network', 'invalid_envelope', 'cancelled')),
  error_message TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  diagnostics_json TEXT NOT NULL,
  attempts_json TEXT NOT NULL,
  expected_metrics_json TEXT NOT NULL,
  trace_json TEXT,
  CHECK ((outcome = 'completed') = (response_json IS NOT NULL)),
  CHECK ((outcome = 'completed') = (error_code IS NULL)),
  CHECK ((error_code IS NULL) = (error_message IS NULL)),
  UNIQUE (run_id, suite_name, case_id)
);

CREATE TABLE metric_results (
  id TEXT PRIMARY KEY,
  case_row_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assertion', 'exec', 'judge')),
  status TEXT NOT NULL CHECK (status IN ('evaluated', 'error')),
  score REAL,
  pass INTEGER,
  rationale TEXT,
  details_json TEXT,
  error_json TEXT,
  judge_io_json TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CHECK ((status = 'evaluated') = (score IS NOT NULL AND pass IS NOT NULL)),
  UNIQUE (case_row_id, metric_name)
);

CREATE TABLE spans (
  id TEXT PRIMARY KEY,
  case_row_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT,
  tool_name TEXT,
  model_name TEXT,
  UNIQUE (case_row_id, span_id)
);

CREATE TABLE response_cache (
  cache_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'judge')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (kind, cache_key)
);

CREATE TRIGGER runs_no_terminal_update
BEFORE UPDATE ON runs
WHEN OLD.status != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER runs_no_terminal_delete
BEFORE DELETE ON runs
WHEN OLD.status != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER cases_no_finalized_insert
BEFORE INSERT ON cases
WHEN (SELECT status FROM runs WHERE id = NEW.run_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER cases_no_finalized_update
BEFORE UPDATE ON cases
WHEN (SELECT status FROM runs WHERE id = OLD.run_id) != 'running'
  OR (SELECT status FROM runs WHERE id = NEW.run_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER cases_no_finalized_delete
BEFORE DELETE ON cases
WHEN (SELECT status FROM runs WHERE id = OLD.run_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER metric_results_no_finalized_insert
BEFORE INSERT ON metric_results
WHEN (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = NEW.case_row_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER metric_results_no_finalized_update
BEFORE UPDATE ON metric_results
WHEN (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = OLD.case_row_id) != 'running'
  OR (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = NEW.case_row_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER metric_results_no_finalized_delete
BEFORE DELETE ON metric_results
WHEN (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = OLD.case_row_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER spans_no_finalized_insert
BEFORE INSERT ON spans
WHEN (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = NEW.case_row_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER spans_no_finalized_update
BEFORE UPDATE ON spans
WHEN (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = OLD.case_row_id) != 'running'
  OR (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = NEW.case_row_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE TRIGGER spans_no_finalized_delete
BEFORE DELETE ON spans
WHEN (SELECT runs.status FROM runs JOIN cases ON cases.run_id = runs.id WHERE cases.id = OLD.case_row_id) != 'running'
BEGIN
  SELECT RAISE(ABORT, 'attest: finalized runs are immutable');
END;

CREATE INDEX idx_cases_run ON cases(run_id);
CREATE INDEX idx_metric_results_case ON metric_results(case_row_id);
CREATE INDEX idx_spans_case ON spans(case_row_id);
CREATE INDEX idx_runs_created ON runs(created_at DESC);
`;

/** Registers the single supported initial schema consumed by the migration runner. */
const migrations = [{ version: 1, name: 'initial', sql: initialSchemaSql }] as const;

export { migrations, initialSchemaSql };
