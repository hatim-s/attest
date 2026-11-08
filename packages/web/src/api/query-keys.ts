import type { ActivityQuery, EvalRunsQuery } from '@attest/api/contract';

/** One project read from one source. */
type ProjectScope = { sourceId: string; projectKey: string };

/** One case of one eval inside one run. */
type CaseIdentity = { runId: string; suiteName: string; caseId: string };

/**
 * Every key starts with the source id, then the project key (`null` for catalog reads), then the
 * resource. Invalidating `source(id)`, `project(scope)` or `run(scope, runId)` reaches exactly that
 * prefix, and two sources never share a cache entry for the same project key.
 */
const queryKeys = {
  source: (sourceId: string) => [sourceId] as const,
  overviews: (sourceId: string) => [sourceId, null, 'overviews'] as const,
  project: ({ sourceId, projectKey }: ProjectScope) => [sourceId, projectKey] as const,
  projectOverview: (scope: ProjectScope) => [...queryKeys.project(scope), 'overview'] as const,
  evals: (scope: ProjectScope) => [...queryKeys.project(scope), 'evals'] as const,
  evalRuns: (scope: ProjectScope, suiteName: string, query: EvalRunsQuery) =>
    [...queryKeys.project(scope), 'eval-runs', suiteName, query] as const,
  /** The Runs tab table, read page by page through the cursor. */
  evalRunPages: (scope: ProjectScope, suiteName: string) =>
    [...queryKeys.project(scope), 'eval-runs', suiteName, 'pages'] as const,
  /** The Test cases tab and the case page's Previous and Next, read in case id order. */
  caseWindow: (scope: ProjectScope, suiteName: string) =>
    [...queryKeys.project(scope), 'case-window', suiteName] as const,
  caseHistory: (scope: ProjectScope, suiteName: string, caseId: string) =>
    [...queryKeys.project(scope), 'case-history', suiteName, caseId] as const,
  activity: (scope: ProjectScope, query: ActivityQuery) =>
    [...queryKeys.project(scope), 'activity', query] as const,
  runs: (scope: ProjectScope) => [...queryKeys.project(scope), 'runs'] as const,
  run: (scope: ProjectScope, runId: string) => [...queryKeys.project(scope), 'run', runId] as const,
  runRecord: (scope: ProjectScope, runId: string) =>
    [...queryKeys.run(scope, runId), 'record'] as const,
  runSuites: (scope: ProjectScope, runId: string) =>
    [...queryKeys.run(scope, runId), 'suites'] as const,
  caseSummaries: (scope: ProjectScope, runId: string, suiteName: string) =>
    [...queryKeys.run(scope, runId), 'cases', suiteName] as const,
  caseRecord: (scope: ProjectScope, { runId, suiteName, caseId }: CaseIdentity) =>
    [...queryKeys.run(scope, runId), 'case', suiteName, caseId] as const,
  diff: (scope: ProjectScope, baseRunId: string, candidateRunId: string) =>
    [...queryKeys.project(scope), 'diff', baseRunId, candidateRunId] as const,
  tests: (scope: ProjectScope) => [...queryKeys.project(scope), 'tests'] as const,
};

export { queryKeys, type ProjectScope, type CaseIdentity };
