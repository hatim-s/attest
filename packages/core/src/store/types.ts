import type { AgentRequest, ContractWarning, Trace } from '@attest/contracts';

type StoreErrorCode =
  | 'SCHEMA_TOO_NEW'
  | 'RUN_NOT_FOUND'
  | 'RUN_FINALIZED'
  | 'OPEN_FAILED'
  | 'INVALID_JSON'
  | 'CORRUPT_DATA'
  | 'WRITE_FAILED';

/** Identifies exceptional store failures that callers can render without parsing messages. */
class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** Describes the lifecycle states persisted for a run (PLAN 1S.2). */
type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Describes the terminal invocation outcome persisted for a case (PLAN 1S.2). */
type CaseOutcome = 'completed' | 'invocation_error' | 'timeout' | 'cancelled';

/** Carries reproducibility metadata captured when a run begins (PLAN 1S.3). */
interface RunMetadata {
  configVersion: string;
  configHash: string;
  configJson: string;
  gitSha?: string;
  gitBranch?: string;
  labels?: Record<string, string>;
}

/** Records why an agent invocation could not produce a usable response (PLAN 1R.1). */
interface InvocationError {
  kind:
    'spawn_failure' | 'nonzero_exit' | 'invalid_output' | 'http_error' | 'timeout' | 'cancelled';
  message: string;
  exitCode?: number;
  stderrExcerpt?: string;
}

/** Captures one agent execution and its canonical request/response evidence (PLAN 1S.3). */
interface StoredCaseExecution {
  caseId: string;
  suiteName: string;
  outcome: CaseOutcome;
  startedAt: string;
  durationMs: number;
  request: AgentRequest;
  response?: unknown;
  responseWarnings?: ContractWarning[];
  invocationError?: InvocationError;
  trace?: Trace;
}

/** Captures one assertion, executable metric, or judge result (PLAN 1M.4 and 1S.3). */
interface StoredMetricEvaluation {
  metricName: string;
  kind: 'assertion' | 'exec' | 'judge';
  status: 'evaluated' | 'error';
  score?: number;
  pass?: boolean;
  rationale?: string;
  details?: unknown;
  error?: { message: string; kind: string };
  judgeIo?: unknown;
  durationMs?: number;
}

/** Summarizes mutually exclusive pass, fail, and invocation-error case totals (PLAN 1S.3). */
interface RunSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  errorCases: number;
  metricErrorCount: number;
}

/** Represents persisted run metadata and its current lifecycle state (PLAN 1S.3). */
interface RunRecord extends RunMetadata {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: RunStatus;
  summary?: RunSummary;
}

/** Represents one persisted case with all metric evaluations restored (PLAN 1S.3). */
interface CaseRecord extends StoredCaseExecution {
  rowId: string;
  runId: string;
  metrics: StoredMetricEvaluation[];
}

/** Defines the durable run lifecycle and query surface required by PLAN 1S.3. */
interface RunStore {
  createRun(metadata: RunMetadata): Promise<RunRecord>;
  recordCase(
    runId: string,
    execution: StoredCaseExecution,
    evaluations: StoredMetricEvaluation[],
  ): Promise<void>;
  finalizeRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord>;
  listRuns(options?: { limit?: number }): Promise<RunRecord[]>;
  getCaseResults(runId: string): Promise<CaseRecord[]>;
  close(): Promise<void>;
}

export {
  StoreError,
  type CaseOutcome,
  type CaseRecord,
  type InvocationError,
  type RunMetadata,
  type RunRecord,
  type RunStore,
  type RunStatus,
  type RunSummary,
  type StoredCaseExecution,
  type StoredMetricEvaluation,
};
