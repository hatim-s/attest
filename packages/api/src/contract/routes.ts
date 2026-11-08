/** Every route is scoped to one catalog project; only the project list sits outside one. */
const apiRoutes = {
  listOverviews: { method: 'GET', path: '/overview' },
  listProjects: { method: 'GET', path: '/projects' },
  getProjectOverview: { method: 'GET', path: '/projects/:projectKey/overview' },
  listEvals: { method: 'GET', path: '/projects/:projectKey/evals' },
  listEvalRuns: { method: 'GET', path: '/projects/:projectKey/evals/:suiteName/runs' },
  getEvalCaseWindow: { method: 'GET', path: '/projects/:projectKey/evals/:suiteName/cases' },
  getCaseHistory: {
    method: 'GET',
    path: '/projects/:projectKey/evals/:suiteName/cases/:caseId/history',
  },
  getActivity: { method: 'GET', path: '/projects/:projectKey/activity' },
  listRuns: { method: 'GET', path: '/projects/:projectKey/runs' },
  getRun: { method: 'GET', path: '/projects/:projectKey/runs/:runId' },
  listCaseSummaries: { method: 'GET', path: '/projects/:projectKey/runs/:runId/cases' },
  getCase: { method: 'GET', path: '/projects/:projectKey/runs/:runId/cases/:suiteName/:caseId' },
  listRunSuites: { method: 'GET', path: '/projects/:projectKey/runs/:runId/suites' },
  getDiff: { method: 'GET', path: '/projects/:projectKey/diffs/:baseRunId/:candidateRunId' },
  listTests: { method: 'GET', path: '/projects/:projectKey/tests' },
  startRun: { method: 'POST', path: '/projects/:projectKey/runs' },
  cancelRun: { method: 'POST', path: '/projects/:projectKey/runs/:runId/cancel' },
} as const satisfies Record<string, { method: 'GET' | 'POST'; path: string }>;

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
