import {
  AttestError,
  type AgentRequest,
  type ContractWarning,
  type Trace,
} from '@attest/contracts';

import type { CacheStore } from './cache.js';

type StoreErrorCode =
  | 'SCHEMA_TOO_NEW'
  | 'RUN_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'RUN_FINALIZED'
  | 'CASE_CONFLICT'
  | 'OPEN_FAILED'
  | 'INVALID_JSON'
  | 'CORRUPT_DATA'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'DRIVER_MISUSE'
  | 'INVALID_RECORD';

/** Identifies exceptional store failures that callers can render without parsing messages. */
class StoreError extends AttestError {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
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

/** Enumerates runner-aligned invocation failures persisted without translation loss. */
type StoredInvocationErrorCode =
  | 'spawn_failed'
  | 'timeout'
  | 'output_cap_exceeded'
  | 'nonzero_exit'
  | 'http_status'
  | 'network'
  | 'invalid_envelope'
  | 'cancelled';

/** Captures bounded process and transport diagnostics for one invocation attempt. */
interface StoredDiagnostics {
  stderrExcerpt?: string;
  exitCode?: number;
  httpStatus?: number;
}

/** Preserves one runner attempt for retry analysis required by the agent contract. */
type StoredAttempt = {
  diagnostics: StoredDiagnostics;
  durationMs: number;
} & (
  | { status: 'ok' }
  | {
      status: 'invocation_error';
      errorCode: StoredInvocationErrorCode;
      errorMessage: string;
    }
);

/** Carries fields shared by every persisted case execution (PLAN 1S.3). */
interface StoredCaseBase {
  caseId: string;
  suiteName: string;
  request: AgentRequest;
  startedAt: string;
  durationMs: number;
  warnings: ContractWarning[];
  diagnostics: StoredDiagnostics;
  attempts: StoredAttempt[];
  expectedMetrics: string[];
}

/** Captures one runner-aligned execution using a runtime-validated terminal discriminant. */
type StoredCaseExecution = StoredCaseBase &
  (
    | { outcome: 'completed'; response: unknown; trace?: Trace }
    | {
        outcome: 'invocation_error' | 'timeout' | 'cancelled';
        errorCode: StoredInvocationErrorCode;
        errorMessage: string;
      }
  );

/** @deprecated Use the discriminated fields on StoredCaseExecution directly. */
type InvocationError = {
  code: StoredInvocationErrorCode;
  message: string;
  diagnostics: StoredDiagnostics;
};

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
type CaseRecord = StoredCaseExecution & {
  rowId: string;
  runId: string;
  metrics: StoredMetricEvaluation[];
};

/** Provides the blob-free case list projection consumed by the PLAN 2V view server. */
interface CaseSummary {
  caseId: string;
  suiteName: string;
  outcome: CaseOutcome;
  verdict: 'pass' | 'fail' | 'error';
  startedAt: string;
  durationMs: number;
  metricCounts: { expected: number; evaluated: number; passed: number; errors: number };
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
  listCaseSummaries(
    runId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ items: CaseSummary[]; nextCursor?: string }>;
  getCase(runId: string, suiteName: string, caseId: string): Promise<CaseRecord>;
  close(): Promise<void>;
}

/** Owns the shared database context for run and cache operations. */
interface AttestStore {
  runs: RunStore;
  cache: CacheStore;
  close(): Promise<void>;
}

export {
  StoreError,
  type AttestStore,
  type CaseOutcome,
  type CaseRecord,
  type CaseSummary,
  type InvocationError,
  type RunMetadata,
  type RunRecord,
  type RunStore,
  type RunStatus,
  type RunSummary,
  type StoreErrorCode,
  type StoredCaseExecution,
  type StoredDiagnostics,
  type StoredInvocationErrorCode,
  type StoredMetricEvaluation,
  type StoredAttempt,
};
