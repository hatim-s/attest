import type { ApiClient } from '@attest/api/client';
import { caseParamsSchema, diffParamsSchema, runParamsSchema } from '@attest/api/contract';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { z } from 'zod';
import { runsQueryOptions } from './api/queries.js';
import { RootLayout } from './routes/root-layout.js';
import { NewestRun } from './routes/newest-run.js';
import { RunPage } from './routes/run-page.js';
import { CaseDrawer } from './routes/case-drawer.js';
import { ComparePage } from './routes/compare-page.js';
import { ErrorNotice } from './components/shared/ui.js';

type RouterContext = { client: ApiClient; queryClient: QueryClient };

const runsSearchSchema = z.object({
  branch: z.string().min(1).optional().catch(undefined),
  label: z
    .string()
    .regex(/^[^=]+=.+$/)
    .optional()
    .catch(undefined),
});

const runSearchSchema = z.object({ tab: z.enum(['cases', 'distributions']).catch('cases') });

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: ({ error }: ErrorComponentProps) => <ErrorNotice error={error} />,
  notFoundComponent: () => <div className="empty-compact">This dashboard page does not exist.</div>,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    return redirect({ to: '/runs', replace: true });
  },
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs',
  validateSearch: runsSearchSchema,
});

const runsIndexRoute = createRoute({
  getParentRoute: () => runsRoute,
  path: '/',
  component: NewestRun,
  beforeLoad: async ({ context, search }) => {
    const runs = await context.queryClient.fetchQuery(runsQueryOptions(context.client));
    const newest = runs[0];

    if (newest !== undefined) {
      return redirect({
        to: '/runs/$runId',
        params: { runId: newest.id },
        search: { ...search, tab: 'cases' },
        replace: true,
      });
    }
  },
});

const runRoute = createRoute({
  getParentRoute: () => runsRoute,
  path: '$runId',
  params: { parse: (params) => runParamsSchema.parse(params) },
  validateSearch: runSearchSchema,
  component: RunPage,
});

const caseRoute = createRoute({
  getParentRoute: () => runRoute,
  path: 'cases/$suiteName/$caseId',
  params: {
    parse: (params) => caseParamsSchema.pick({ suiteName: true, caseId: true }).parse(params),
  },
  component: CaseDrawer,
});

const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/compare/$baseRunId/$candidateRunId',
  params: { parse: (params) => diffParamsSchema.parse(params) },
  component: ComparePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  runsRoute.addChildren([runsIndexRoute, runRoute.addChildren([caseRoute])]),
  compareRoute,
]);

/** Accepts history so production can use hashes and invariant tests can navigate without a DOM. */
const createDashboardRouter = (history: RouterHistory, context: RouterContext) =>
  createRouter({ routeTree, history, context });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }
}

export { createDashboardRouter };
