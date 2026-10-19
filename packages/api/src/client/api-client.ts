import type {
  CaseRecord,
  CaseSummaryPage,
  PageQuery,
  RunDiff,
  RunPage,
  RunRecord,
} from '@attest/core/records';
import type { SuiteHistoryQuery } from '../contract/requests.js';
import type { ProjectList, RunSuites, SuiteHistory } from '../contract/responses.js';
import type { DashboardBootstrap } from '../contract/bootstrap.js';
import type { apiRoutes, PathParams } from '../contract/routes.js';
import { createHttpClient } from './http-client.js';
import { createSnapshotClient } from './snapshot-client.js';

type RequestOptions = { signal?: AbortSignal };

type ApiClientMode =
  | { kind: 'live' }
  | { kind: 'snapshot'; generatedAt: string; includedCases: number; truncated: boolean };

type ApiClient = {
  mode: ApiClientMode;
  listProjects(options?: RequestOptions): Promise<ProjectList>;
  listRuns(
    params: PathParams<typeof apiRoutes.listRuns>,
    query: PageQuery,
    options?: RequestOptions,
  ): Promise<RunPage>;
  getRun(params: PathParams<typeof apiRoutes.getRun>, options?: RequestOptions): Promise<RunRecord>;
  listCaseSummaries(
    params: PathParams<typeof apiRoutes.listCaseSummaries>,
    query: PageQuery,
    options?: RequestOptions,
  ): Promise<CaseSummaryPage>;
  getCase(
    params: PathParams<typeof apiRoutes.getCase>,
    options?: RequestOptions,
  ): Promise<CaseRecord>;
  listRunSuites(
    params: PathParams<typeof apiRoutes.listRunSuites>,
    options?: RequestOptions,
  ): Promise<RunSuites>;
  getSuiteHistory(
    params: PathParams<typeof apiRoutes.getSuiteHistory>,
    query: SuiteHistoryQuery,
    options?: RequestOptions,
  ): Promise<SuiteHistory>;
  getDiff(params: PathParams<typeof apiRoutes.getDiff>, options?: RequestOptions): Promise<RunDiff>;
};

type ApiClientConfig =
  | Exclude<DashboardBootstrap, { kind: 'http' }>
  | (Extract<DashboardBootstrap, { kind: 'http' }> & { fetch?: typeof fetch });

/** Keeps host selection at startup so dashboard queries share one read interface. */
const createApiClient = (config: ApiClientConfig): ApiClient =>
  config.kind === 'http'
    ? createHttpClient(config.baseUrl, config.fetch ?? ((input, init) => fetch(input, init)))
    : createSnapshotClient(config.snapshot);

export {
  createApiClient,
  type ApiClient,
  type ApiClientMode,
  type ApiClientConfig,
  type RequestOptions,
};
