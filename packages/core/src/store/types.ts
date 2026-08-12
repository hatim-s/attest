import { AttestError, type CaseOutcome } from '@attest/contracts';

import type { CacheStore } from './cache.js';
import type {
  CaseRecord,
  RunMetadata,
  RunRecord,
  RunSummary,
  StoredAttempt,
  StoredCaseExecution,
  StoredDiagnostics,
  StoredMetricEvaluation,
} from './internal/record-schema.js';

type StoreErrorCode =
  | 'SCHEMA_TOO_NEW'
  | 'SCHEMA_OUTDATED'
  | 'RUN_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'INVALID_LIMIT'
  | 'RUN_FINALIZED'
  | 'CASE_CONFLICT'
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

/** Describes lifecycle states persisted for a run. */
type RunStatus = RunRecord['status'];

/** Supplies a preallocated immutable identity when another record owns the run id. */
interface RunIdentity {
  id: string;
  createdAt: string;
}

/** Provides the blob-free case list projection consumed by the PLAN 2V view server. */
interface CaseSummary {
  caseId: string;
  suiteName: string;
  outcome: CaseOutcome;
  verdict: 'pass' | 'fail' | 'error';
  startedAt: string;
  durationMs: number;
  score?: number;
  metricCounts: { expected: number; evaluated: number; passed: number; errors: number };
}

/** Defines the durable run lifecycle and query surface required by PLAN 1S.3. */
interface RunStore {
  createRun(metadata: RunMetadata, identity?: RunIdentity): Promise<RunRecord>;
  recordCase(
    runId: string,
    execution: StoredCaseExecution,
    evaluations: StoredMetricEvaluation[],
  ): Promise<void>;
  finalizeRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord>;
  listRuns(options?: { limit?: number }): Promise<RunRecord[]>;
  getCaseResults(runId: string): Promise<CaseRecord[]>;
  getRunWithCases(runId: string): Promise<{ run: RunRecord; cases: CaseRecord[] }>;
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
  type RunMetadata,
  type RunIdentity,
  type RunRecord,
  type RunStore,
  type RunStatus,
  type RunSummary,
  type StoreErrorCode,
  type StoredCaseExecution,
  type StoredDiagnostics,
  type StoredMetricEvaluation,
  type StoredAttempt,
};
