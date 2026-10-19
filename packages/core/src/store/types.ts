import type { PageQuery, RunPage, CaseSummaryPage } from '../records/page-schemas.js';
import type { ProjectRecord } from '../records/project-schemas.js';
import type {
  RunCancelOutcome,
  RunStartRequest,
  TestSummary,
} from '../records/run-control-schemas.js';
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

/**
 * The read contract for every run host. Writes stay on RunStore.
 * Missing runs throw StoreError RUN_NOT_FOUND; a missing case in an existing run
 * throws CASE_NOT_FOUND. Unknown cursors throw INVALID_CURSOR, including a case
 * cursor from another run. Invalid limits throw INVALID_LIMIT.
 * listRuns returns newest first with deterministic ties. Case order stays stable
 * across pages. Cursors are opaque and identify the last item of the prior page.
 * Limits default to DEFAULT_PAGE_LIMIT, 100, and accept integers from 1 through
 * MAX_PAGE_LIMIT, 1,000, inclusive.
 */
interface RunSource {
  listRuns(query?: PageQuery): Promise<RunPage>;
  getRun(runId: string): Promise<RunRecord>;
  listCaseSummaries(runId: string, query?: PageQuery): Promise<CaseSummaryPage>;
  getCase(runId: string, suiteName: string, caseId: string): Promise<CaseRecord>;
  getRunWithCases(runId: string): Promise<{ run: RunRecord; cases: CaseRecord[] }>;
}

/**
 * Lists projects and opens their run sources. Unknown keys throw StoreError PROJECT_NOT_FOUND.
 * Keys match /^[a-z0-9][a-z0-9-]{0,63}$/. listProjects returns keys in ascending order.
 */
interface ProjectCatalog {
  listProjects(): Promise<ProjectRecord[]>;
  openProject(key: string): Promise<RunSource>;
}

/**
 * Starts and cancels runs in one catalog project. Hosts that cannot run evals provide none.
 * Unknown keys throw StoreError PROJECT_NOT_FOUND; a project these runs cannot reach throws
 * CONTROL_UNAVAILABLE; a run that does not start throws RUN_START_FAILED with the diagnostics;
 * a project that does not load, or a cancel the project refuses, throws PROJECT_UNLOADABLE with
 * the diagnostics; cancelling an unknown run throws RUN_NOT_FOUND. Concurrent runs in one project
 * are allowed.
 */
interface RunControl {
  listTests(projectKey: string): Promise<TestSummary[]>;
  /** Resolves once the run is recorded, so its id can be read straight away. */
  startRun(projectKey: string, request: RunStartRequest): Promise<{ runId: string }>;
  cancelRun(projectKey: string, runId: string): Promise<{ outcome: RunCancelOutcome }>;
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
  type ProjectCatalog,
  type ProjectRecord,
  type RunControl,
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
