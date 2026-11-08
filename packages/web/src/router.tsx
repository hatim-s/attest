import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { stripStruct, SchemaDecodeError } from '@attest/contracts';
import { parseWithSchemaSync } from '@attest/contracts';
import {
  caseParamsSchema,
  diffParamsSchema,
  projectParamsSchema,
  runParamsSchema,
  evalParamsSchema,
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
import { runsQueryOptions } from './api/queries.js';
import { projectOverviewQueryOptions } from './api/queries/projects.js';
import type { DashboardSource } from './api/dashboard-source.js';
import { EvalRunsPage } from './routes/eval/eval-runs-page.js';
import { DirectoryPage } from './routes/directory/directory-page.js';
import { ProjectPage } from './routes/project/project-page.js';
import { PROJECT_RANGES } from './routes/project/project-range.js';
import { RunsLayout } from './routes/runs-layout.js';
import { DashboardFrame } from './routes/frame/dashboard-frame.js';
import { NewestRun } from './routes/newest-run.js';
import { RunPage } from './routes/run-page.js';
import { CaseDrawer } from './routes/case-drawer.js';
import { ComparePage } from './routes/compare-page.js';
import { ErrorNotice } from './components/shared/ui.js';
import { runTabSchema } from './components/runs/run-tabs.js';

type RouterContext = { source: DashboardSource; queryClient: QueryClient };

const runsSearchSchema = stripStruct({
  branch: Schema.optional(Schema.String.check(Schema.isMinLength(1))).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
  label: Schema.optional(Schema.String.check(Schema.isPattern(/^[^=]+=.+$/))).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
});

const runSearchSchema = stripStruct({
  tab: runTabSchema
    .pipe(Schema.withDecodingDefault(Effect.succeed('cases')))
    .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some('cases')))),
});

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: DashboardFrame,
  notFoundComponent: () => <div className="empty-compact">This dashboard page does not exist.</div>,
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
  // An unknown key fails here, so the error notice replaces the page with the API message.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      projectOverviewQueryOptions(context.source, params.projectKey),
    ),
});

/** `range` is the period in days; `eval` picks the eval on the pass-rate chart. */
const projectSearchSchema = stripStruct({
  range: Schema.Literals(PROJECT_RANGES)
    .pipe(Schema.withDecodingDefault(Effect.succeed(PROJECT_RANGES[0])))
    .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(PROJECT_RANGES[0])))),
  eval: Schema.optional(Schema.String.check(Schema.isMinLength(1))).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  validateSearch: Schema.toStandardSchemaV1(projectSearchSchema, {
    parseOptions: { onExcessProperty: 'error', errors: 'all' },
  }),
  component: ProjectPage,
});

/** The run list, run and comparison pages that the compact eval routes will replace. */
const workspaceRoute = createRoute({
  getParentRoute: () => projectRoute,
  id: 'workspace',
  component: RunsLayout,
  validateSearch: Schema.toStandardSchemaV1(runsSearchSchema, {
    parseOptions: { onExcessProperty: 'error', errors: 'all' },
  }),
});

const runsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'runs',
});

const runsIndexRoute = createRoute({
  getParentRoute: () => runsRoute,
  path: '/',
  component: NewestRun,
  beforeLoad: async ({ context, params, search }) => {
    const page = await context.queryClient.fetchQuery(
      runsQueryOptions(context.source.client, params.projectKey),
    );

    const newest = page.items[0];

    if (newest !== undefined) {
      return redirect({
        to: '/projects/$projectKey/runs/$runId',
        params: { projectKey: params.projectKey, runId: newest.id },
        search,
      });
    }
  },
});

const runRoute = createRoute({
  getParentRoute: () => runsRoute,
  path: '$runId',
  params: { parse: (params) => parseWithSchemaSync(runParamsSchema, params) },
  validateSearch: Schema.toStandardSchemaV1(runSearchSchema, {
    parseOptions: { onExcessProperty: 'error', errors: 'all' },
  }),
  component: RunPage,
});

const caseRoute = createRoute({
  getParentRoute: () => runRoute,
  path: 'cases/$suiteName/$caseId',
  params: {
    parse: (params) =>
      parseWithSchemaSync(
        stripStruct({
          suiteName: caseParamsSchema.from.schema.fields.suiteName,
          caseId: caseParamsSchema.from.schema.fields.caseId,
        }),
        params,
      ),
  },
  component: CaseDrawer,
});

const compareRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'compare/$baseRunId/$candidateRunId',
  params: { parse: (params) => parseWithSchemaSync(diffParamsSchema, params) },
  component: ComparePage,
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

/** `x` spaces the eval's pass-rate trend by run (equal slots) or by date. */
const evalRunsSearchSchema = stripStruct({
  x: Schema.Literals(['run', 'date'])
    .pipe(Schema.withDecodingDefault(Effect.succeed('run')))
    .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some('run')))),
});

const evalRunsRoute = createRoute({
  getParentRoute: () => evalRoute,
  path: 'runs',
  validateSearch: Schema.toStandardSchemaV1(evalRunsSearchSchema, {
    parseOptions: { onExcessProperty: 'error', errors: 'all' },
  }),
  component: EvalRunsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute.addChildren([
    projectIndexRoute,
    workspaceRoute.addChildren([
      runsRoute.addChildren([runsIndexRoute, runRoute.addChildren([caseRoute])]),
      compareRoute,
    ]),
    evalRoute.addChildren([evalIndexRoute, evalRunsRoute]),
  ]),
]);

/** Uses hash history in the dashboard and accepts memory history for non-browser callers. */
const createDashboardRouter = (history: RouterHistory, context: RouterContext) =>
  createRouter({
    routeTree,
    history,
    context,
    defaultErrorComponent: ({ error }: ErrorComponentProps) => (
      <ErrorNotice
        error={
          error instanceof Error && error.cause instanceof SchemaDecodeError
            ? new Error(
                `Invalid dashboard URL. ${error.cause.issues.map((issue) => issue.message).join(' ')}`,
              )
            : error
        }
      />
    ),
    defaultNotFoundComponent: () => (
      <div className="empty-compact">This dashboard page does not exist.</div>
    ),
  });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }

  interface HistoryState {
    /** Set by links on the run page, so the case drawer knows Back returns to that run. */
    caseOpenedFromRun?: true;
  }
}

export { createDashboardRouter };
