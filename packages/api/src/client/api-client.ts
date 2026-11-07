import type * as Effect from 'effect/Effect';
import type {
  CaseRecord,
  CaseSummaryPage,
  PageQuery,
  RunDiff,
  RunPage,
  RunRecord,
  RunStartRequest,
} from '@attest/core/records';
import type { SuiteHistoryQuery } from '../contract/requests.js';
import type {
  ProjectList,
  RunCancelResponse,
  RunStartResponse,
  RunSuites,
  SuiteHistory,
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
  listProjects(options?: RequestOptions): Effect.Effect<ProjectList, ApiError | Error>;
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
    query: PageQuery,
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
  getSuiteHistory(
    params: PathParams<typeof apiRoutes.getSuiteHistory.path>,
    query: SuiteHistoryQuery,
    options?: RequestOptions,
  ): Effect.Effect<SuiteHistory, ApiError | Error>;
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

type ApiClientConfig =
  | Exclude<DashboardBootstrap, { kind: 'http' }>
  | (Extract<DashboardBootstrap, { kind: 'http' }> & { fetch?: typeof fetch });

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
