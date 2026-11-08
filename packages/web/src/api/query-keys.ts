import type { ActivityQuery, EvalRunsQuery } from '@attest/api/contract';

/** One project read from one source. */
type ProjectScope = { sourceId: string; projectKey: string };

/**
 * Every key starts with the source id, then the project key (`null` for catalog reads), then the
 * resource. Invalidating `source(id)` or `project(scope)` reaches exactly that prefix, and two
 * sources never share a cache entry for the same project key.
 */
const queryKeys = {
  source: (sourceId: string) => [sourceId] as const,
  overviews: (sourceId: string) => [sourceId, null, 'overviews'] as const,
  project: ({ sourceId, projectKey }: ProjectScope) => [sourceId, projectKey] as const,
  projectOverview: (scope: ProjectScope) => [...queryKeys.project(scope), 'overview'] as const,
  evals: (scope: ProjectScope) => [...queryKeys.project(scope), 'evals'] as const,
  evalRuns: (scope: ProjectScope, suiteName: string, query: EvalRunsQuery) =>
    [...queryKeys.project(scope), 'eval-runs', suiteName, query] as const,
  activity: (scope: ProjectScope, query: ActivityQuery) =>
    [...queryKeys.project(scope), 'activity', query] as const,
};

export { queryKeys, type ProjectScope };
