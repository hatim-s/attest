import * as Effect from 'effect/Effect';
import { queryOptions } from '@tanstack/react-query';
import type { EvalRunsQuery } from '@attest/api/contract';
import type { DashboardSource } from '../dashboard-source.js';
import { queryKeys } from '../query-keys.js';
import { refreshPolicy } from './refresh.js';

/** The overview reads the same first page, so the sidebar and project page see the same evals. */
const EVAL_PAGE_LIMIT = 500;

/**
 * A project's evals with their latest slices. `running` comes from the overview that owns the
 * project, so the list polls only while one of the project's runs executes.
 */
const evalsQueryOptions = (source: DashboardSource, projectKey: string, running: boolean) =>
  queryOptions({
    queryKey: queryKeys.evals({ sourceId: source.id, projectKey }),
    queryFn: ({ signal }) =>
      Effect.runPromise(
        source.client.listEvals({ projectKey }, { limit: EVAL_PAGE_LIMIT }, { signal }),
      ),
    ...refreshPolicy(source, running),
  });

/** One eval's slices in a window, newest first. Refreshed by focus and the project change signal. */
const evalSlicesQueryOptions = (
  source: DashboardSource,
  projectKey: string,
  suiteName: string,
  query: EvalRunsQuery,
) =>
  queryOptions({
    queryKey: queryKeys.evalRuns({ sourceId: source.id, projectKey }, suiteName, query),
    queryFn: ({ signal }) =>
      Effect.runPromise(source.client.listEvalRuns({ projectKey, suiteName }, query, { signal })),
    ...refreshPolicy(source, false),
  });

export { evalsQueryOptions, evalSlicesQueryOptions };
