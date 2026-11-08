import type * as Effect from 'effect/Effect';
import type {
  Activity,
  CaseHistoryPage,
  CaseRecord,
  CaseSummaryPage,
  EvalCaseWindow,
  EvalPage,
  EvalRunPage,
  PageQuery,
  ProjectRunOverview,
  RunDiff,
  RunPage,
  RunRecord,
  RunStartRequest,
} from '@attest/core/records';
import type { ActivityQuery, CaseSummariesQuery, EvalRunsQuery } from '../contract/requests.js';
import type { ProjectOverviewList } from '../contract/overview.js';
import type {
  ProjectList,
  RunCancelResponse,
  RunStartResponse,
  RunSuites,
  TestList,
} from '../contract/responses.js';
import type { ApiCapabilities, DashboardBootstrap } from '../contract/bootstrap.js';
import type { apiRoutes, PathParams } from '../contract/routes.js';
import type { ApiError } from './api-error.js';
import { createHttpClient } from './http-client.js';
import { createSnapshotClient } from './snapshot-client.js';

type RequestOptions = { signal?: AbortSignal };

type ApiClientMode =
  | { kind: 'live' }
  | { kind: 'snapshot'; generatedAt: string; includedCases: number; truncated: boolean };

type ApiClient = {
  mode: ApiClientMode;
  /** Hide run controls when `control` is false; those calls reject with CONTROL_UNAVAILABLE. */
  capabilities: ApiCapabilities;
  listOverviews(options?: RequestOptions): Effect.Effect<ProjectOverviewList, ApiError | Error>;
  listProjects(options?: RequestOptions): Effect.Effect<ProjectList, ApiError | Error>;
  getProjectOverview(
    params: PathParams<typeof apiRoutes.getProjectOverview.path>,
    options?: RequestOptions,
  ): Effect.Effect<ProjectRunOverview, ApiError | Error>;
  listEvals(
    params: PathParams<typeof apiRoutes.listEvals.path>,
    query: PageQuery,
    options?: RequestOptions,
  ): Effect.Effect<EvalPage, ApiError | Error>;
  listEvalRuns(
    params: PathParams<typeof apiRoutes.listEvalRuns.path>,
    query: EvalRunsQuery,
    options?: RequestOptions,
  ): Effect.Effect<EvalRunPage, ApiError | Error>;
  getEvalCaseWindow(
    params: PathParams<typeof apiRoutes.getEvalCaseWindow.path>,
    query: PageQuery,
    options?: RequestOptions,
  ): Effect.Effect<EvalCaseWindow, ApiError | Error>;
  getCaseHistory(
    params: PathParams<typeof apiRoutes.getCaseHistory.path>,
    query: PageQuery,
    options?: RequestOptions,
  ): Effect.Effect<CaseHistoryPage, ApiError | Error>;
  getActivity(
    params: PathParams<typeof apiRoutes.getActivity.path>,
    query: ActivityQuery,
    options?: RequestOptions,
  ): Effect.Effect<Activity, ApiError | Error>;
  listRuns(
    params: PathParams<typeof apiRoutes.listRuns.path>,
    query: PageQuery,
    options?: RequestOptions,
  ): Effect.Effect<RunPage, ApiError | Error>;
  getRun(
    params: PathParams<typeof apiRoutes.getRun.path>,
    options?: RequestOptions,
  ): Effect.Effect<RunRecord, ApiError | Error>;
  listCaseSummaries(
    params: PathParams<typeof apiRoutes.listCaseSummaries.path>,
    query: CaseSummariesQuery,
    options?: RequestOptions,
  ): Effect.Effect<CaseSummaryPage, ApiError | Error>;
  getCase(
    params: PathParams<typeof apiRoutes.getCase.path>,
    options?: RequestOptions,
  ): Effect.Effect<CaseRecord, ApiError | Error>;
  listRunSuites(
    params: PathParams<typeof apiRoutes.listRunSuites.path>,
    options?: RequestOptions,
  ): Effect.Effect<RunSuites, ApiError | Error>;
  getDiff(
    params: PathParams<typeof apiRoutes.getDiff.path>,
    options?: RequestOptions,
  ): Effect.Effect<RunDiff, ApiError | Error>;
  listTests(
    params: PathParams<typeof apiRoutes.listTests.path>,
    options?: RequestOptions,
  ): Effect.Effect<TestList, ApiError | Error>;
  startRun(
    params: PathParams<typeof apiRoutes.startRun.path>,
    request: RunStartRequest,
    options?: RequestOptions,
  ): Effect.Effect<RunStartResponse, ApiError | Error>;
  cancelRun(
    params: PathParams<typeof apiRoutes.cancelRun.path>,
    options?: RequestOptions,
  ): Effect.Effect<RunCancelResponse, ApiError | Error>;
};

/** The client reads the same way from every HTTP host, so it ignores which host serves it. */
type ApiClientConfig =
  | Exclude<DashboardBootstrap, { kind: 'http' }>
  | (Omit<Extract<DashboardBootstrap, { kind: 'http' }>, 'host'> & { fetch?: typeof fetch });

/** Keeps host selection at startup so dashboard queries share one read interface. */
const createApiClient = (config: ApiClientConfig): ApiClient =>
  config.kind === 'http'
    ? createHttpClient(
        config.baseUrl,
        config.capabilities,
        config.fetch ?? ((input, init) => fetch(input, init)),
      )
    : createSnapshotClient(config.snapshot);

export {
  createApiClient,
  type ApiClient,
  type ApiClientMode,
  type ApiClientConfig,
  type RequestOptions,
};
