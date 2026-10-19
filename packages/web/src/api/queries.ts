import { useEffect } from 'react';
import type { ApiClient } from '@attest/api/client';
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import type { RunStartRequest, RunStatus } from '@attest/core/records';
import { useApiClient } from './api-client-context.js';

/** Lists the catalog once; the `/` redirect and the projects page share it. */
const projectsQueryOptions = (client: ApiClient) =>
  queryOptions({
    queryKey: ['projects'],
    queryFn: async ({ signal }) => (await client.listProjects({ signal })).items,
  });

/** Lets the projects page reuse the catalog the `/` redirect already loaded. */
const useProjects = () => useQuery(projectsQueryOptions(useApiClient()));

/**
 * Shares the newest-first page between the index redirect, the polling sidebar and the projects
 * index. The page keeps its cursor so callers can tell a full page from a short one.
 */
const runsQueryOptions = (client: ApiClient, projectKey: string) =>
  queryOptions({
    queryKey: ['runs', projectKey],
    queryFn: ({ signal }) => client.listRuns({ projectKey }, {}, { signal }),
    // An idle page still refreshes slowly, so a run started from a terminal shows up.
    refetchInterval: (query) => {
      if (client.mode.kind !== 'live') return false;

      return query.state.data?.items.some((run) => run.status === 'running') ? 5_000 : 30_000;
    },
  });

/** Keeps the sidebar current without polling file-based reports. */
const useRuns = (projectKey: string) => useQuery(runsQueryOptions(useApiClient(), projectKey));

/** One runs query per project, sharing cache entries with `useRuns`; results follow `projectKeys`. */
const useRunsForProjects = (projectKeys: readonly string[]) => {
  const client = useApiClient();

  return useQueries({ queries: projectKeys.map((key) => runsQueryOptions(client, key)) });
};

/** Loads one run and keeps polling only while it is still executing. */
const useRun = (projectKey: string, runId: string) => {
  const client = useApiClient();

  return useQuery({
    queryKey: ['run', projectKey, runId],
    queryFn: ({ signal }) => client.getRun({ projectKey, runId }, { signal }),
    refetchInterval: (query) =>
      client.mode.kind === 'live' && query.state.data?.status === 'running' ? 2_000 : false,
  });
};

/** Refreshes recorded cases during execution and once more when the run finishes. */
const useCases = (projectKey: string, runId: string, status: RunStatus | undefined) => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const isLive = client.mode.kind === 'live';
  useEffect(() => {
    // The last case can arrive between the final interval and the completed run response.
    if (isLive && status !== undefined && status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['cases', projectKey, runId] });
    }
  }, [isLive, projectKey, queryClient, runId, status]);

  return useInfiniteQuery({
    queryKey: ['cases', projectKey, runId],
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      client.listCaseSummaries(
        { projectKey, runId },
        { cursor: pageParam, limit: 250 },
        { signal },
      ),
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
const caseQueryOptions = (
  client: ApiClient,
  projectKey: string,
  { runId, suiteName, caseId, status }: CaseSelection,
) =>
  queryOptions({
    queryKey: ['case', projectKey, runId, suiteName, caseId, status],
    queryFn: ({ signal }) => client.getCase({ projectKey, runId, suiteName, caseId }, { signal }),
    refetchInterval: client.mode.kind === 'live' && status === 'running' ? 2_000 : false,
  });

/** Both run statuses participate so either run finishing refreshes the comparison. */
const diffQueryOptions = (
  client: ApiClient,
  projectKey: string,
  { baseRunId, candidateRunId, baseStatus, candidateStatus }: ComparisonSelection,
) =>
  queryOptions({
    queryKey: ['diff', projectKey, baseRunId, candidateRunId, baseStatus, candidateStatus],
    queryFn: ({ signal }) => client.getDiff({ projectKey, baseRunId, candidateRunId }, { signal }),
    refetchInterval:
      client.mode.kind === 'live' && (baseStatus === 'running' || candidateStatus === 'running')
        ? 2_000
        : false,
  });

/** Keeps the open drawer current through the final run response. */
const useCase = (projectKey: string, selection: CaseSelection) =>
  useQuery(caseQueryOptions(useApiClient(), projectKey, selection));

/** Keeps the routed comparison current while either run is executing. */
const useDiff = (projectKey: string, selection: ComparisonSelection) =>
  useQuery(diffQueryOptions(useApiClient(), projectKey, selection));

/** Status is part of the cache key so completion refreshes the final suite totals. */
const runSuitesQueryOptions = (
  client: ApiClient,
  projectKey: string,
  runId: string | undefined,
  status: RunStatus | undefined,
) =>
  queryOptions({
    queryKey: ['run-suites', projectKey, runId, status],
    queryFn: ({ signal }) => client.listRunSuites({ projectKey, runId: runId ?? '' }, { signal }),
    enabled: runId !== undefined,
    refetchInterval: client.mode.kind === 'live' && status === 'running' ? 2_000 : false,
  });

/** Shares suite totals between a run and the evals index. */
const useRunSuites = (
  projectKey: string,
  runId: string | undefined,
  status: RunStatus | undefined,
) => useQuery(runSuitesQueryOptions(useApiClient(), projectKey, runId, status));

/** Walks past running-only pages so evals always starts from the newest finished run. */
const newestCompletedRunQueryOptions = (client: ApiClient, projectKey: string) =>
  queryOptions({
    queryKey: ['newest-completed-run', projectKey],
    queryFn: async ({ signal }) => {
      let cursor: string | undefined;

      do {
        const page = await client.listRuns({ projectKey }, { cursor }, { signal });
        const run = page.items.find((item) => item.status !== 'running');

        if (run !== undefined) return run;
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      return null;
    },
    refetchInterval: client.mode.kind === 'live' ? 5_000 : false,
  });

/** Refreshes the eval catalog when a new run completes. */
const useNewestCompletedRun = (projectKey: string) =>
  useQuery(newestCompletedRunQueryOptions(useApiClient(), projectKey));

/** Keeps the history limit in the cache identity and polls only live sources. */
const suiteHistoryQueryOptions = (
  client: ApiClient,
  projectKey: string,
  suiteName: string,
  limit: number,
) =>
  queryOptions({
    queryKey: ['suite-history', projectKey, suiteName, limit],
    queryFn: ({ signal }) =>
      client.getSuiteHistory({ projectKey, suiteName }, { limit }, { signal }),
    refetchInterval: client.mode.kind === 'live' ? 5_000 : false,
  });

/** Lets both history charts consume a single parsed response. */
const useSuiteHistory = (projectKey: string, suiteName: string, limit: number) =>
  useQuery(suiteHistoryQueryOptions(useApiClient(), projectKey, suiteName, limit));

/** Lists the tests a new run can select. Tests change only when someone edits the project. */
const useTests = (projectKey: string) => {
  const client = useApiClient();

  return useQuery({
    queryKey: ['tests', projectKey],
    queryFn: async ({ signal }) => (await client.listTests({ projectKey }, { signal })).items,
  });
};

/** Starts a run, then refreshes the project's runs page so the sidebar and projects table list it. */
const useStartRun = (projectKey: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: RunStartRequest) => client.startRun({ projectKey }, request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['runs', projectKey] }),
  });
};

/** Requests cancellation, then refreshes the run and the sidebar so a new status shows at once. */
const useCancelRun = (projectKey: string, runId: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.cancelRun({ projectKey, runId }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['run', projectKey, runId] }),
        queryClient.invalidateQueries({ queryKey: ['runs', projectKey] }),
      ]),
  });
};

export {
  projectsQueryOptions,
  useProjects,
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
  useRunsForProjects,
  useTests,
  useStartRun,
  useCancelRun,
};
