import { useEffect } from 'react';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import { getCase, getDiff, getRun, listCases, listRuns } from './client.js';
import type { RunStatus } from './types.js';
import { getReportData } from '../report/report-data.js';

/** Polls recent runs in the live dashboard and keeps static reports offline. */
const useRuns = () =>
  useQuery({
    queryKey: ['runs'],
    queryFn: listRuns,
    refetchInterval: getReportData() === undefined ? 5_000 : false,
  });

/** Loads one run and keeps polling only while it is still executing. */
const useRun = (runId: string | undefined) =>
  useQuery({
    queryKey: ['run', runId],
    queryFn: () => getRun(runId ?? ''),
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
    queryFn: ({ pageParam }) => listCases(runId ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: runId !== undefined,
    refetchInterval: isLive && status === 'running' ? 2_000 : false,
  });
};

/** Loads the full evidence record for the case opened in the detail drawer. */
const useCase = (
  runId: string | undefined,
  suiteName: string | undefined,
  caseId: string | undefined,
) =>
  useQuery({
    queryKey: ['case', runId, suiteName, caseId],
    queryFn: () => getCase(runId ?? '', suiteName ?? '', caseId ?? ''),
    enabled: runId !== undefined && suiteName !== undefined && caseId !== undefined,
  });

/** Compares two distinct runs once both sides of the comparison are chosen. */
const useDiff = (baseRunId: string | undefined, candidateRunId: string | undefined) =>
  useQuery({
    queryKey: ['diff', baseRunId, candidateRunId],
    queryFn: () => getDiff(baseRunId ?? '', candidateRunId ?? ''),
    enabled:
      baseRunId !== undefined && candidateRunId !== undefined && baseRunId !== candidateRunId,
  });

export { useCase, useCases, useDiff, useRun, useRuns };
