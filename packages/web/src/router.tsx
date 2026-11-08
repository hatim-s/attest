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
import { projectsQueryOptions, runsQueryOptions } from './api/queries.js';
import { projectOverviewQueryOptions } from './api/queries/projects.js';
import type { DashboardSource } from './api/dashboard-source.js';
import { EvalsPage } from './routes/evals-page.js';
import { EvalPage } from './routes/eval-page.js';
import { ProjectsPage } from './routes/projects-page.js';
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

/** A catalog with one project opens it directly; any other catalog starts at the project list. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const projects = await context.queryClient.fetchQuery(
      projectsQueryOptions(context.source.client),
    );

    const [only] = projects;

    if (projects.length === 1 && only !== undefined) {
      return redirect({ to: '/projects/$projectKey/runs', params: { projectKey: only.key } });
    }

    return redirect({ to: '/projects' });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
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

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  beforeLoad: ({ params }) => redirect({ to: '/projects/$projectKey/runs', params }),
});

/** The run list, run, comparison and eval pages that the compact eval routes will replace. */
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

const evalsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'evals',
  component: EvalsPage,
});

const evalRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'evals/$suiteName',
  params: { parse: (params) => parseWithSchemaSync(evalParamsSchema, params) },
  validateSearch: Schema.toStandardSchemaV1(
    stripStruct({
      limit: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
        .pipe(Schema.withDecodingDefault(Effect.succeed(20)))
        .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(20)))),
    }),
    { parseOptions: { onExcessProperty: 'error', errors: 'all' } },
  ),
  component: EvalPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  projectRoute.addChildren([
    projectIndexRoute,
    workspaceRoute.addChildren([
      runsRoute.addChildren([runsIndexRoute, runRoute.addChildren([caseRoute])]),
      compareRoute,
      evalsRoute,
      evalRoute,
    ]),
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
