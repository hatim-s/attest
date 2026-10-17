import type { PageQuery, RunPage, CaseSummaryPage } from '../records/page-schemas.js';
import type { CaseSummary, CaseVerdict } from '../records/projection-schemas.js';
import type { CacheStore } from './cache.js';
import type {
  CaseRecord,
  RunMetadata,
  RunRecord,
  RunSummary,
  StoredAttempt,
  StoredCaseExecution,
  StoredMetricEvaluation,
} from './internal/record-schema.js';

/** Describes lifecycle states persisted for a run. */
type RunStatus = RunRecord['status'];

/** Supplies a preallocated immutable identity when another record owns the run id. */
interface RunIdentity {
  id: string;
  createdAt: string;
}

/** The read operations every run data host implements. Writes stay on RunStore. */
interface RunSource {
  listRuns(query?: PageQuery): Promise<RunPage>;
  getRun(runId: string): Promise<RunRecord>;
  listCaseSummaries(runId: string, query?: PageQuery): Promise<CaseSummaryPage>;
  getCase(runId: string, suiteName: string, caseId: string): Promise<CaseRecord>;
  getRunWithCases(runId: string): Promise<{ run: RunRecord; cases: CaseRecord[] }>;
}

/** Defines durable run writes; reads come from RunSource. */
interface RunStore extends RunSource {
  createRun(metadata: RunMetadata, identity?: RunIdentity): Promise<RunRecord>;
  // BOUNDARY: Hosts validate untrusted execution and metric records against the store schemas before writing their transaction.
  recordCase(runId: string, execution: unknown, evaluations: unknown): Promise<void>;
  finalizeRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<RunRecord>;
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
  type RunSource,
  type RunStore,
  type RunStatus,
  type RunSummary,
  type StoredCaseExecution,
  type StoredMetricEvaluation,
  type StoredAttempt,
};
