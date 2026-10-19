/**
 * Every route is scoped to one catalog project; only the project list sits outside one.
 * `startRun` and `cancelRun` are POST routes; `startRun` shares its path with `listRuns`.
 */
const apiRoutes = {
  listProjects: '/projects',
  listRuns: '/projects/:projectKey/runs',
  getRun: '/projects/:projectKey/runs/:runId',
  listCaseSummaries: '/projects/:projectKey/runs/:runId/cases',
  getCase: '/projects/:projectKey/runs/:runId/cases/:suiteName/:caseId',
  listRunSuites: '/projects/:projectKey/runs/:runId/suites',
  getSuiteHistory: '/projects/:projectKey/suites/:suiteName/history',
  getDiff: '/projects/:projectKey/diffs/:baseRunId/:candidateRunId',
  listTests: '/projects/:projectKey/tests',
  startRun: '/projects/:projectKey/runs',
  cancelRun: '/projects/:projectKey/runs/:runId/cancel',
} as const;

type ApiRoute = keyof typeof apiRoutes;

type PathParams<Pattern extends string> = Pattern extends `${string}:${infer Name}/${infer Rest}`
  ? { [Key in Name]: string } & PathParams<`/${Rest}`>
  : Pattern extends `${string}:${infer Name}`
    ? { [Key in Name]: string }
    : Record<never, never>;

/** Keeps slashes inside parameter values within a single route segment. */
const buildPath = <Pattern extends string>(
  pattern: Pattern,
  params: PathParams<Pattern> & Record<string, string>,
): string =>
  Object.entries(params).reduce<string>(
    (path, [name, value]) => path.replace(`:${name}`, encodeURIComponent(value)),
    pattern,
  );

export { apiRoutes, buildPath, type ApiRoute, type PathParams };
