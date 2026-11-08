import * as Effect from 'effect/Effect';
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { RunStartRequest } from '@attest/core/records';
import type { DashboardSource } from '../dashboard-source.js';
import { queryKeys, type CaseIdentity } from '../query-keys.js';
import { refreshPolicy, runRefetchInterval } from './refresh.js';

/** The Runs tab opens on the newest ten runs; each "Show older runs" reads up to a hundred more. */
const FIRST_RUN_PAGE = 10;

const OLDER_RUN_PAGE = 100;

/** Case rows of one eval in one run, read in run order. */
const CASE_PAGE_LIMIT = 500;

/** Rows per page of the project's run list. */
const PROJECT_RUN_PAGE = 25;

/** Pages read through an opaque cursor; the first page has none. */
type CursorContext = { pageParam: string | undefined; signal: AbortSignal };

const scopeOf = (source: DashboardSource, projectKey: string) => ({
  sourceId: source.id,
  projectKey,
});

/** One run's record. It polls while the run executes and stops on its own once it finishes. */
const runQueryOptions = (source: DashboardSource, projectKey: string, runId: string) =>
  queryOptions({
    queryKey: queryKeys.runRecord(scopeOf(source, projectKey), runId),
    queryFn: ({ signal }) =>
      Effect.runPromise(source.client.getRun({ projectKey, runId }, { signal })),
    ...refreshPolicy(source, false),
    refetchInterval: (query) => runRefetchInterval(source, query.state.data?.status === 'running'),
  });

/** Every eval slice of one run. `running` comes from the run record that owns the lifecycle. */
const runSuitesQueryOptions = (
  source: DashboardSource,
  projectKey: string,
  runId: string,
  running: boolean,
) =>
  queryOptions({
    queryKey: queryKeys.runSuites(scopeOf(source, projectKey), runId),
    queryFn: ({ signal }) =>
      Effect.runPromise(source.client.listRunSuites({ projectKey, runId }, { signal })),
    ...refreshPolicy(source, false),
    refetchInterval: runRefetchInterval(source, running),
  });

/** Case summaries of one eval in one run, in run order, a page at a time. */
const caseSummariesQueryOptions = (
  source: DashboardSource,
  projectKey: string,
  { runId, suiteName }: Omit<CaseIdentity, 'caseId'>,
  running: boolean,
) =>
  infiniteQueryOptions({
    queryKey: queryKeys.caseSummaries(scopeOf(source, projectKey), runId, suiteName),
    queryFn: ({ pageParam, signal }: CursorContext) =>
      Effect.runPromise(
        source.client.listCaseSummaries(
          { projectKey, runId },
          { cursor: pageParam, limit: CASE_PAGE_LIMIT, suiteName },
          { signal },
        ),
      ),
    initialPageParam: undefined,
    getNextPageParam: (page): string | undefined => page.nextCursor,
    ...refreshPolicy(source, false),
    refetchInterval: runRefetchInterval(source, running),
  });

/** One recorded case. A recorded case never changes, so it is read once. */
const caseRecordQueryOptions = (
  source: DashboardSource,
  projectKey: string,
  identity: CaseIdentity,
) =>
  queryOptions({
    queryKey: queryKeys.caseRecord(scopeOf(source, projectKey), identity),
    queryFn: ({ signal }) =>
      Effect.runPromise(source.client.getCase({ projectKey, ...identity }, { signal })),
    staleTime: Infinity,
  });

/** A whole-run comparison. Callers filter it to one eval and read it only when asked to. */
const diffQueryOptions = (
  source: DashboardSource,
  projectKey: string,
  baseRunId: string,
  candidateRunId: string,
) =>
  queryOptions({
    queryKey: queryKeys.diff(scopeOf(source, projectKey), baseRunId, candidateRunId),
    queryFn: ({ signal }) =>
      Effect.runPromise(
        source.client.getDiff({ projectKey, baseRunId, candidateRunId }, { signal }),
      ),
    ...refreshPolicy(source, false),
  });

/** One eval's runs for the Runs tab table, newest first. */
const evalRunPagesQueryOptions = (source: DashboardSource, projectKey: string, suiteName: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.evalRunPages(scopeOf(source, projectKey), suiteName),
    queryFn: ({ pageParam, signal }: CursorContext) =>
      Effect.runPromise(
        source.client.listEvalRuns(
          { projectKey, suiteName },
          {
            cursor: pageParam,
            limit: pageParam === undefined ? FIRST_RUN_PAGE : OLDER_RUN_PAGE,
          },
          { signal },
        ),
      ),
    initialPageParam: undefined,
    getNextPageParam: (page): string | undefined => page.nextCursor,
    ...refreshPolicy(source, false),
  });

/** Every run of the project, newest first, for the All runs page. */
const projectRunsQueryOptions = (source: DashboardSource, projectKey: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.runs(scopeOf(source, projectKey)),
    queryFn: ({ pageParam, signal }: CursorContext) =>
      Effect.runPromise(
        source.client.listRuns(
          { projectKey },
          { cursor: pageParam, limit: PROJECT_RUN_PAGE },
          { signal },
        ),
      ),
    initialPageParam: undefined,
    getNextPageParam: (page): string | undefined => page.nextCursor,
    ...refreshPolicy(source, false),
  });

/** The tests a new run can select. They change only when someone edits the project. */
const testsQueryOptions = (source: DashboardSource, projectKey: string) =>
  queryOptions({
    queryKey: queryKeys.tests(scopeOf(source, projectKey)),
    queryFn: async ({ signal }) =>
      (await Effect.runPromise(source.client.listTests({ projectKey }, { signal }))).items,
    ...refreshPolicy(source, false),
  });

/** Starts a run, then refreshes the project's reads so lists and the sidebar show it. */
const useStartRun = (source: DashboardSource, projectKey: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: RunStartRequest) =>
      Effect.runPromise(source.client.startRun({ projectKey }, request)),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.project(scopeOf(source, projectKey)) }),
  });
};

/** Requests cancellation, then refreshes the run's reads so its new lifecycle shows at once. */
const useCancelRun = (source: DashboardSource, projectKey: string, runId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => Effect.runPromise(source.client.cancelRun({ projectKey, runId })),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.run(scopeOf(source, projectKey), runId),
      }),
  });
};

export {
  runQueryOptions,
  runSuitesQueryOptions,
  caseSummariesQueryOptions,
  caseRecordQueryOptions,
  diffQueryOptions,
  evalRunPagesQueryOptions,
  projectRunsQueryOptions,
  testsQueryOptions,
  useStartRun,
  useCancelRun,
  OLDER_RUN_PAGE,
};
