import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getCase, getDiff, getRun, listCases, listRuns } from './client.js';

/** Polls the recent-run navigator while the dashboard stays open. */
const useRuns = () => useQuery({ queryKey: ['runs'], queryFn: listRuns, refetchInterval: 5_000 });

/** Loads one run and keeps polling only while it is still executing. */
const useRun = (runId: string | undefined) =>
  useQuery({
    queryKey: ['run', runId],
    queryFn: () => getRun(runId ?? ''),
    enabled: runId !== undefined,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2_000 : false),
  });

/** Pages case summaries for the selected run through cursor pagination. */
const useCases = (runId: string | undefined) =>
  useInfiniteQuery({
    queryKey: ['cases', runId],
    queryFn: ({ pageParam }) => listCases(runId ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: runId !== undefined,
  });

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
