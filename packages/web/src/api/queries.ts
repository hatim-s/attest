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
const useRun = (runId: string) => {
  const client = useApiClient();

  return useQuery({
    queryKey: ['run', runId],
    queryFn: ({ signal }) => client.getRun({ runId }, { signal }),
    refetchInterval: (query) =>
      client.mode.kind === 'live' && query.state.data?.status === 'running' ? 2_000 : false,
  });
};

/** Refreshes recorded cases during execution and once more when the run finishes. */
const useCases = (runId: string, status: RunStatus | undefined) => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const isLive = client.mode.kind === 'live';
  useEffect(() => {
    // The last case can arrive between the final interval and the completed run response.
    if (isLive && status !== undefined && status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['cases', runId] });
    }
  }, [isLive, queryClient, runId, status]);

  return useInfiniteQuery({
    queryKey: ['cases', runId],
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      client.listCaseSummaries({ runId }, { cursor: pageParam, limit: 250 }, { signal }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: isLive && status === 'running' ? 2_000 : false,
  });
};

type CaseSelection = {
  runId: string;
  suiteName: string;
  caseId: string;
  status: RunStatus | undefined;
};

type ComparisonSelection = {
  baseRunId: string;
  candidateRunId: string;
  baseStatus: RunStatus | undefined;
  candidateStatus: RunStatus | undefined;
};

/** A status change gets a fresh cache entry even after active polling has stopped. */
const caseQueryOptions = (client: ApiClient, { runId, suiteName, caseId, status }: CaseSelection) =>
  queryOptions({
    queryKey: ['case', runId, suiteName, caseId, status],
    queryFn: ({ signal }) => client.getCase({ runId, suiteName, caseId }, { signal }),
    refetchInterval: client.mode.kind === 'live' && status === 'running' ? 2_000 : false,
  });

/** Both run statuses participate so either run finishing refreshes the comparison. */
const diffQueryOptions = (
  client: ApiClient,
  { baseRunId, candidateRunId, baseStatus, candidateStatus }: ComparisonSelection,
) =>
  queryOptions({
    queryKey: ['diff', baseRunId, candidateRunId, baseStatus, candidateStatus],
    queryFn: ({ signal }) => client.getDiff({ baseRunId, candidateRunId }, { signal }),
    refetchInterval:
      client.mode.kind === 'live' && (baseStatus === 'running' || candidateStatus === 'running')
        ? 2_000
        : false,
  });

/** Keeps the open drawer current through the final run response. */
const useCase = (selection: CaseSelection) => useQuery(caseQueryOptions(useApiClient(), selection));

/** Keeps the routed comparison current while either run is executing. */
const useDiff = (selection: ComparisonSelection) =>
  useQuery(diffQueryOptions(useApiClient(), selection));

export {
  runsQueryOptions,
  caseQueryOptions,
  diffQueryOptions,
  useCase,
  useCases,
  useDiff,
  useRun,
  useRuns,
};
