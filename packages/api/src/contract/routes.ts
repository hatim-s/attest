const apiRoutes = {
  listRuns: '/runs',
  getRun: '/runs/:runId',
  listCaseSummaries: '/runs/:runId/cases',
  getCase: '/runs/:runId/cases/:suiteName/:caseId',
  listRunSuites: '/runs/:runId/suites',
  getSuiteHistory: '/suites/:suiteName/history',
  getDiff: '/diffs/:baseRunId/:candidateRunId',
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
