import { useEffect } from 'react';
import type { ApiClient } from '@attest/api/client';
import { queryOptions, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RunStatus } from '@attest/core/records';
import { useApiClient } from './api-client-context.js';

/** Shares the newest-first page between the index redirect and the polling sidebar. */
const runsQueryOptions = (client: ApiClient) =>
  queryOptions({
    queryKey: ['runs'],
    queryFn: async ({ signal }) => (await client.listRuns({}, { signal })).items,
    refetchInterval: client.mode.kind === 'live' ? 5_000 : false,
  });

/** Keeps the sidebar current without polling file-based reports. */
const useRuns = () => useQuery(runsQueryOptions(useApiClient()));

/** Loads one run and keeps polling only while it is still executing. */
const useRun = (runId: string | undefined) => {
  const client = useApiClient();

  return useQuery({
    queryKey: ['run', runId],
    queryFn: ({ signal }) => client.getRun({ runId: runId ?? '' }, { signal }),
    enabled: runId !== undefined,
    refetchInterval: (query) =>
      client.mode.kind === 'live' && query.state.data?.status === 'running' ? 2_000 : false,
  });
};

/** Refreshes recorded cases during execution and once more when the run finishes. */
const useCases = (runId: string | undefined, status: RunStatus | undefined) => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const isLive = client.mode.kind === 'live';
  useEffect(() => {
    // The last case can arrive between the final interval and the completed run response.
    if (isLive && runId !== undefined && status !== undefined && status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['cases', runId] });
    }
  }, [isLive, queryClient, runId, status]);

  return useInfiniteQuery({
    queryKey: ['cases', runId],
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      client.listCaseSummaries(
        { runId: runId ?? '' },
        { cursor: pageParam, limit: 250 },
        { signal },
      ),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: runId !== undefined,
    refetchInterval: isLive && status === 'running' ? 2_000 : false,
  });
};

type CaseSelection = {
  runId: string | undefined;
  suiteName: string | undefined;
  caseId: string | undefined;
  status: RunStatus | undefined;
};

type ComparisonSelection = {
  baseRunId: string | undefined;
  candidateRunId: string | undefined;
  baseStatus: RunStatus | undefined;
  candidateStatus: RunStatus | undefined;
  visible: boolean;
};

/** A status change gets a fresh cache entry even after active polling has stopped. */
const caseQueryOptions = (client: ApiClient, { runId, suiteName, caseId, status }: CaseSelection) =>
  queryOptions({
    queryKey: ['case', runId, suiteName, caseId, status],
    queryFn: ({ signal }) =>
      client.getCase(
        { runId: runId ?? '', suiteName: suiteName ?? '', caseId: caseId ?? '' },
        { signal },
      ),
    enabled: runId !== undefined && suiteName !== undefined && caseId !== undefined,
    refetchInterval: client.mode.kind === 'live' && status === 'running' ? 2_000 : false,
  });

/** Both run statuses participate so either run finishing refreshes the comparison. */
const diffQueryOptions = (
  client: ApiClient,
  { baseRunId, candidateRunId, baseStatus, candidateStatus, visible }: ComparisonSelection,
) =>
  queryOptions({
    queryKey: ['diff', baseRunId, candidateRunId, baseStatus, candidateStatus],
    queryFn: ({ signal }) =>
      client.getDiff(
        { baseRunId: baseRunId ?? '', candidateRunId: candidateRunId ?? '' },
        { signal },
      ),
    enabled:
      visible &&
      baseRunId !== undefined &&
      candidateRunId !== undefined &&
      baseRunId !== candidateRunId,
    refetchInterval:
      client.mode.kind === 'live' && (baseStatus === 'running' || candidateStatus === 'running')
        ? 2_000
        : false,
  });

/** Keeps the open drawer current through the final run response. */
const useCase = (selection: CaseSelection) => useQuery(caseQueryOptions(useApiClient(), selection));

/** Fetches comparisons only while Compare is visible. */
const useDiff = (selection: ComparisonSelection) =>
  useQuery(diffQueryOptions(useApiClient(), selection));

/** Status is part of the cache key so completion refreshes the final suite totals. */
const runSuitesQueryOptions = (
  client: ApiClient,
  runId: string | undefined,
  status: RunStatus | undefined,
) =>
  queryOptions({
    queryKey: ['run-suites', runId, status],
    queryFn: ({ signal }) => client.listRunSuites({ runId: runId ?? '' }, { signal }),
    enabled: runId !== undefined,
    refetchInterval: client.mode.kind === 'live' && status === 'running' ? 2_000 : false,
  });

/** Shares suite totals between a run and the evals index. */
const useRunSuites = (runId: string | undefined, status: RunStatus | undefined) =>
  useQuery(runSuitesQueryOptions(useApiClient(), runId, status));

/** Walks past running-only pages so evals always starts from the newest finished run. */
const newestCompletedRunQueryOptions = (client: ApiClient) =>
  queryOptions({
    queryKey: ['newest-completed-run'],
    queryFn: async ({ signal }) => {
      let cursor: string | undefined;

      do {
        const page = await client.listRuns({ cursor }, { signal });
        const run = page.items.find((item) => item.status !== 'running');

        if (run !== undefined) return run;
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      return null;
    },
    refetchInterval: client.mode.kind === 'live' ? 5_000 : false,
  });

/** Refreshes the eval catalog when a new run completes. */
const useNewestCompletedRun = () => useQuery(newestCompletedRunQueryOptions(useApiClient()));

/** Keeps the history limit in the cache identity and polls only live sources. */
const suiteHistoryQueryOptions = (client: ApiClient, suiteName: string, limit: number) =>
  queryOptions({
    queryKey: ['suite-history', suiteName, limit],
    queryFn: ({ signal }) => client.getSuiteHistory({ suiteName }, { limit }, { signal }),
    refetchInterval: client.mode.kind === 'live' ? 5_000 : false,
  });

/** Lets both history charts consume a single parsed response. */
const useSuiteHistory = (suiteName: string, limit: number) =>
  useQuery(suiteHistoryQueryOptions(useApiClient(), suiteName, limit));

export {
  newestCompletedRunQueryOptions,
  suiteHistoryQueryOptions,
  useNewestCompletedRun,
  useSuiteHistory,
  runSuitesQueryOptions,
  useRunSuites,
  runsQueryOptions,
  caseQueryOptions,
  diffQueryOptions,
  useCase,
  useCases,
  useDiff,
  useRun,
  useRuns,
};
