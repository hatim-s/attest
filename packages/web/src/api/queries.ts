import { useEffect } from 'react';

import { queryOptions, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import { getCase, getDiff, getRun, listCases, listRuns } from './client.js';
import type { RunStatus } from './types.js';
import { getReportData } from '../report/report-data.js';

/** Polls recent runs in the live dashboard and keeps static reports offline. */
const useRuns = () =>
  useQuery({
    queryKey: ['runs'],
    queryFn: ({ signal }) => listRuns(signal),
    refetchInterval: getReportData() === undefined ? 5_000 : false,
  });

/** Loads one run and keeps polling only while it is still executing. */
const useRun = (runId: string | undefined) =>
  useQuery({
    queryKey: ['run', runId],
    queryFn: ({ signal }) => getRun(runId ?? '', signal),
    enabled: runId !== undefined,
    refetchInterval: (query) =>
      getReportData() === undefined && query.state.data?.status === 'running' ? 2_000 : false,
  });

/** Refreshes recorded cases during execution and once more when the run finishes. */
const useCases = (runId: string | undefined, status: RunStatus | undefined) => {
  const queryClient = useQueryClient();
  const isLive = getReportData() === undefined;
  useEffect(() => {
    // The last case can arrive between the final interval and the completed run response.
    if (isLive && runId !== undefined && status !== undefined && status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['cases', runId] });
    }
  }, [isLive, queryClient, runId, status]);

  return useInfiniteQuery({
    queryKey: ['cases', runId],
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      listCases(runId ?? '', pageParam, signal),
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
const caseQueryOptions = ({ runId, suiteName, caseId, status }: CaseSelection) =>
  queryOptions({
    queryKey: ['case', runId, suiteName, caseId, status],
    queryFn: ({ signal }) =>
      getCase(runId ?? '', { suiteName: suiteName ?? '', caseId: caseId ?? '' }, signal),
    enabled: runId !== undefined && suiteName !== undefined && caseId !== undefined,
    refetchInterval: getReportData() === undefined && status === 'running' ? 2_000 : false,
  });

/** Both run statuses participate so either run finishing refreshes the comparison. */
const diffQueryOptions = ({
  baseRunId,
  candidateRunId,
  baseStatus,
  candidateStatus,
  visible,
}: ComparisonSelection) =>
  queryOptions({
    queryKey: ['diff', baseRunId, candidateRunId, baseStatus, candidateStatus],
    queryFn: ({ signal }) => getDiff(baseRunId ?? '', candidateRunId ?? '', signal),
    enabled:
      visible &&
      baseRunId !== undefined &&
      candidateRunId !== undefined &&
      baseRunId !== candidateRunId,
    refetchInterval:
      getReportData() === undefined && (baseStatus === 'running' || candidateStatus === 'running')
        ? 2_000
        : false,
  });

/** Keeps the open drawer current through the final run response. */
const useCase = (selection: CaseSelection) => useQuery(caseQueryOptions(selection));

/** Fetches comparisons only while Compare is visible. */
const useDiff = (selection: ComparisonSelection) => useQuery(diffQueryOptions(selection));

export { caseQueryOptions, diffQueryOptions, useCase, useCases, useDiff, useRun, useRuns };
