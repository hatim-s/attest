import type { CaseOutcome } from '@attest/contracts';

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

/** Describes lifecycle states persisted for a run. */
type RunStatus = RunRecord['status'];

/** Supplies a preallocated immutable identity when another record owns the run id. */
interface RunIdentity {
  id: string;
  createdAt: string;
}

/** Case-level verdict derived from invocation and metric outcomes. */
type CaseVerdict = 'pass' | 'fail' | 'error';

/** Provides the blob-free case list projection consumed by the view server. */
interface CaseSummary {
  caseId: string;
  suiteName: string;
  outcome: CaseOutcome;
  verdict: CaseVerdict;
  startedAt: string;
  durationMs: number;
  score?: number;
  metricCounts: { expected: number; evaluated: number; passed: number; errors: number };
}

/** Defines durable run writes and queries. */
interface RunStore {
  createRun(metadata: RunMetadata, identity?: RunIdentity): Promise<RunRecord>;
  recordCase(
    runId: string,
    execution: StoredCaseExecution,
    evaluations: StoredMetricEvaluation[],
  ): Promise<void>;
  finalizeRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord>;
  listRuns(limit?: number): Promise<RunRecord[]>;
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
  type AttestStore,
  type CaseRecord,
  type CaseSummary,
  type CaseVerdict,
  type RunMetadata,
  type RunIdentity,
  type RunRecord,
  type RunStore,
  type RunStatus,
  type RunSummary,
  type StoredCaseExecution,
  type StoredDiagnostics,
  type StoredMetricEvaluation,
  type StoredAttempt,
};
