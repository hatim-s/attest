import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { stripStruct, SchemaDecodeError } from '@attest/contracts';
import { parseWithSchemaSync } from '@attest/contracts';
import {
  caseParamsSchema,
  evalParamsSchema,
  projectParamsSchema,
  runParamsSchema,
} from '@attest/api/contract';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import * as Schema from 'effect/Schema';
import { projectOverviewQueryOptions } from './api/queries/projects.js';
import { runSuitesQueryOptions } from './api/queries/runs.js';
import type { DashboardSource } from './api/dashboard-source.js';
import { EmptyState } from './components/empty/empty-state.js';
import { DirectoryPage } from './routes/directory/directory-page.js';
import { EvalRunsPage } from './routes/eval/eval-runs-page.js';
import { CASE_FILTERS } from './routes/eval-cases/case-standing.js';
import { EvalCasesPage } from './routes/eval-cases/eval-cases-page.js';
import { EvalRunPage } from './routes/eval-run/eval-run-page.js';
import { DashboardFrame } from './routes/frame/dashboard-frame.js';
import { ProjectPage } from './routes/project/project-page.js';
import { PROJECT_RANGES } from './routes/project/project-range.js';
import { AllRunsPage } from './routes/project-run/all-runs-page.js';
import { ProjectRunPage } from './routes/project-run/project-run-page.js';
import { runDestination } from './routes/project-run/run-destination.js';
import { RunCasePage } from './routes/run-case/run-case-page.js';

type RouterContext = { source: DashboardSource; queryClient: QueryClient };

/** Unknown search keys fail the URL instead of passing through silently. */
const strictSearch = { parseOptions: { onExcessProperty: 'error', errors: 'all' } } as const;

/** `range` is the period in days; `eval` picks the eval on the pass-rate chart. */
const projectSearchSchema = stripStruct({
  range: Schema.Literals(PROJECT_RANGES)
    .pipe(Schema.withDecodingDefault(Effect.succeed(PROJECT_RANGES[0])))
    .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(PROJECT_RANGES[0])))),
  eval: Schema.optional(Schema.String.check(Schema.isMinLength(1))).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
});

/** `x` spaces the eval's pass-rate trend by run (equal slots) or by date. */
const evalRunsSearchSchema = stripStruct({
  x: Schema.Literals(['run', 'date'])
    .pipe(Schema.withDecodingDefault(Effect.succeed('run')))
    .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some('run')))),
});

/** `q` searches case ids; `filter` picks the All, Failing or Flaky chip. */
const evalCasesSearchSchema = stripStruct({
  q: Schema.optional(Schema.String.check(Schema.isMinLength(1))).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
  filter: Schema.Literals(CASE_FILTERS)
    .pipe(Schema.withDecodingDefault(Effect.succeed(CASE_FILTERS[0])))
    .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(CASE_FILTERS[0])))),
});

const NotFound = () => (
  <EmptyState
    title="This page does not exist"
    description="The link may be out of date. Pick a project or eval from the sidebar."
  />
);

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: DashboardFrame,
  notFoundComponent: NotFound,
});

/** Every project in the catalog; a single-project catalog lists its one row too. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DirectoryPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectKey',
  params: { parse: (params) => parseWithSchemaSync(projectParamsSchema, params) },
  // An unknown key fails here, so the error state replaces the page with the API message.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      projectOverviewQueryOptions(context.source, params.projectKey),
    ),
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  validateSearch: Schema.toStandardSchemaV1(projectSearchSchema, strictSearch),
  component: ProjectPage,
});

/** Every run of the project, across its evals. */
const projectRunsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'runs',
  component: AllRunsPage,
});

/**
 * Cloud upload responses link to `#/projects/<key>/runs/<id>`. A run with one eval opens that
 * eval's run page; a run with several lists them.
 */
const projectRunRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'runs/$runId',
  params: { parse: (params) => parseWithSchemaSync(runParamsSchema, params) },
  beforeLoad: async ({ context, params }) => {
    const { suites } = await context.queryClient.fetchQuery(
      runSuitesQueryOptions(context.source, params.projectKey, params.runId, false),
    );

    const destination = runDestination(suites);

    if (destination.kind === 'eval')
      return redirect({
        to: '/projects/$projectKey/evals/$suiteName/runs/$runId',
        params: { ...params, suiteName: destination.suiteName },
        replace: true,
      });
  },
  component: ProjectRunPage,
});

const evalRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'evals/$suiteName',
  params: { parse: (params) => parseWithSchemaSync(evalParamsSchema, params) },
});

/** The eval opens on its Runs tab. */
const evalIndexRoute = createRoute({
  getParentRoute: () => evalRoute,
  path: '/',
  beforeLoad: ({ params }) =>
    redirect({
      to: '/projects/$projectKey/evals/$suiteName/runs',
      params,
      search: { x: 'run' },
      replace: true,
    }),
});

const evalRunsRoute = createRoute({
  getParentRoute: () => evalRoute,
  path: 'runs',
  validateSearch: Schema.toStandardSchemaV1(evalRunsSearchSchema, strictSearch),
  component: EvalRunsPage,
});

const evalCasesRoute = createRoute({
  getParentRoute: () => evalRoute,
  path: 'cases',
  validateSearch: Schema.toStandardSchemaV1(evalCasesSearchSchema, strictSearch),
  component: EvalCasesPage,
});

const evalRunRoute = createRoute({
  getParentRoute: () => evalRoute,
  path: 'runs/$runId',
  params: {
    parse: (params) =>
      parseWithSchemaSync(stripStruct({ runId: runParamsSchema.from.schema.fields.runId }), params),
  },
  component: EvalRunPage,
});

const runCaseRoute = createRoute({
  getParentRoute: () => evalRoute,
  path: 'runs/$runId/cases/$caseId',
  params: {
    parse: (params) =>
      parseWithSchemaSync(
        stripStruct({
          runId: caseParamsSchema.from.schema.fields.runId,
          caseId: caseParamsSchema.from.schema.fields.caseId,
        }),
        params,
      ),
  },
  component: RunCasePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute.addChildren([
    projectIndexRoute,
    projectRunsRoute,
    projectRunRoute,
    evalRoute.addChildren([
      evalIndexRoute,
      evalRunsRoute,
      evalCasesRoute,
      evalRunRoute,
      runCaseRoute,
    ]),
  ]),
]);

/** A bad URL names the parameter that failed; any other error shows its own message. */
const RouteError = ({ error }: ErrorComponentProps) => {
  const description =
    error instanceof Error && error.cause instanceof SchemaDecodeError
      ? `Invalid dashboard URL. ${error.cause.issues.map((issue) => issue.message).join(' ')}`
      : error instanceof Error
        ? error.message
        : 'Something went wrong.';

  return <EmptyState title="This page could not load" description={description} />;
};

/** Uses hash history in the dashboard and accepts memory history for non-browser callers. */
const createDashboardRouter = (history: RouterHistory, context: RouterContext) =>
  createRouter({
    routeTree,
    history,
    context,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
  });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }
}

export { createDashboardRouter };
