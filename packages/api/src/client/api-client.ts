import type {
  CaseRecord,
  CaseSummaryPage,
  PageQuery,
  RunDiff,
  RunPage,
  RunRecord,
} from '@attest/core/records';
import type { DashboardBootstrap } from '../contract/bootstrap.js';
import { createHttpClient } from './http-client.js';
import { createSnapshotClient } from './snapshot-client.js';

type RequestOptions = { signal?: AbortSignal };

type ApiClientMode =
  | { kind: 'live' }
  | { kind: 'snapshot'; generatedAt: string; includedCases: number; truncated: boolean };

type ApiClient = {
  mode: ApiClientMode;
  listRuns(query: PageQuery, options?: RequestOptions): Promise<RunPage>;
  getRun(params: { runId: string }, options?: RequestOptions): Promise<RunRecord>;
  listCaseSummaries(
    params: { runId: string },
    query: PageQuery,
    options?: RequestOptions,
  ): Promise<CaseSummaryPage>;
  getCase(
    params: { runId: string; suiteName: string; caseId: string },
    options?: RequestOptions,
  ): Promise<CaseRecord>;
  getDiff(
    params: { baseRunId: string; candidateRunId: string },
    options?: RequestOptions,
  ): Promise<RunDiff>;
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
