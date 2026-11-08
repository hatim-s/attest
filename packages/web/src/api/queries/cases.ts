import * as Effect from 'effect/Effect';
import { infiniteQueryOptions } from '@tanstack/react-query';
import type { DashboardSource } from '../dashboard-source.js';
import { queryKeys } from '../query-keys.js';
import { refreshPolicy } from './refresh.js';

/** Cases per page of the Test cases tab. Each row carries at most ten cells. */
const CASE_WINDOW_PAGE = 100;

/** The case page opens on as many runs as the Test cases tab shows; "Show all" reads more. */
const FIRST_HISTORY_PAGE = 10;

const OLDER_HISTORY_PAGE = 100;

/** Pages read through an opaque cursor; the first page has none. */
type CursorContext = { pageParam: string | undefined; signal: AbortSignal };

/**
 * One eval's cases in case id order, each with its cells in the eval's newest ten runs. Every page
 * repeats the same `runs`, because the cursor pins the window it started with.
 */
const caseWindowQueryOptions = (source: DashboardSource, projectKey: string, suiteName: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.caseWindow({ sourceId: source.id, projectKey }, suiteName),
    queryFn: ({ pageParam, signal }: CursorContext) =>
      Effect.runPromise(
        source.client.getEvalCaseWindow(
          { projectKey, suiteName },
          { cursor: pageParam, limit: CASE_WINDOW_PAGE },
          { signal },
        ),
      ),
    initialPageParam: undefined,
    getNextPageParam: (page): string | undefined => page.nextCursor,
    ...refreshPolicy(source, false),
  });

/** One case's outcomes across runs, newest first. Refreshed by the project change signal. */
const caseHistoryQueryOptions = (
  source: DashboardSource,
  projectKey: string,
  suiteName: string,
  caseId: string,
) =>
  infiniteQueryOptions({
    queryKey: queryKeys.caseHistory({ sourceId: source.id, projectKey }, suiteName, caseId),
    queryFn: ({ pageParam, signal }: CursorContext) =>
      Effect.runPromise(
        source.client.getCaseHistory(
          { projectKey, suiteName, caseId },
          {
            cursor: pageParam,
            limit: pageParam === undefined ? FIRST_HISTORY_PAGE : OLDER_HISTORY_PAGE,
          },
          { signal },
        ),
      ),
    initialPageParam: undefined,
    getNextPageParam: (page): string | undefined => page.nextCursor,
    ...refreshPolicy(source, false),
  });

export { caseWindowQueryOptions, caseHistoryQueryOptions };
