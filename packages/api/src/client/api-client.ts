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
  listProjects(options?: RequestOptions): Promise<ProjectList>;
  listRuns(
    params: PathParams<typeof apiRoutes.listRuns.path>,
    query: PageQuery,
    options?: RequestOptions,
  ): Promise<RunPage>;
  getRun(
    params: PathParams<typeof apiRoutes.getRun.path>,
    options?: RequestOptions,
  ): Promise<RunRecord>;
  listCaseSummaries(
    params: PathParams<typeof apiRoutes.listCaseSummaries.path>,
    query: PageQuery,
    options?: RequestOptions,
  ): Promise<CaseSummaryPage>;
  getCase(
    params: PathParams<typeof apiRoutes.getCase.path>,
    options?: RequestOptions,
  ): Promise<CaseRecord>;
  listRunSuites(
    params: PathParams<typeof apiRoutes.listRunSuites.path>,
    options?: RequestOptions,
  ): Promise<RunSuites>;
  getSuiteHistory(
    params: PathParams<typeof apiRoutes.getSuiteHistory.path>,
    query: SuiteHistoryQuery,
    options?: RequestOptions,
  ): Promise<SuiteHistory>;
  getDiff(
    params: PathParams<typeof apiRoutes.getDiff.path>,
    options?: RequestOptions,
  ): Promise<RunDiff>;
  listTests(
    params: PathParams<typeof apiRoutes.listTests.path>,
    options?: RequestOptions,
  ): Promise<TestList>;
  startRun(
    params: PathParams<typeof apiRoutes.startRun.path>,
    request: RunStartRequest,
    options?: RequestOptions,
  ): Promise<RunStartResponse>;
  cancelRun(
    params: PathParams<typeof apiRoutes.cancelRun.path>,
    options?: RequestOptions,
  ): Promise<RunCancelResponse>;
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
