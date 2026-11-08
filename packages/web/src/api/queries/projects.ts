import * as Effect from 'effect/Effect';
import { queryOptions } from '@tanstack/react-query';
import type { ProjectOverviewList } from '@attest/api/contract';
import type { ProjectRunOverview } from '@attest/core/records';
import type { DashboardSource } from '../dashboard-source.js';
import { queryKeys } from '../query-keys.js';
import { refreshPolicy } from './refresh.js';

/** True while any readable project in the catalog has a run in progress. */
const catalogRunning = (list: ProjectOverviewList | undefined) =>
  list?.items.some((entry) => entry.status === 'ready' && entry.overview.runningRunCount > 0) ??
  false;

/** The catalog with one precomputed overview per project; the directory and sidebar share it. */
const overviewsQueryOptions = (source: DashboardSource) =>
  queryOptions({
    queryKey: queryKeys.overviews(source.id),
    queryFn: ({ signal }) => Effect.runPromise(source.client.listOverviews({ signal })),
    ...refreshPolicy(source, false),
    refetchInterval: (query) =>
      refreshPolicy(source, catalogRunning(query.state.data)).refetchInterval,
  });

/** One project's overview. Its running count drives polling for the project's eval list. */
const projectOverviewQueryOptions = (source: DashboardSource, projectKey: string) =>
  queryOptions({
    queryKey: queryKeys.projectOverview({ sourceId: source.id, projectKey }),
    queryFn: ({ signal }): Promise<ProjectRunOverview> =>
      Effect.runPromise(source.client.getProjectOverview({ projectKey }, { signal })),
    ...refreshPolicy(source, false),
    refetchInterval: (query) =>
      refreshPolicy(source, (query.state.data?.runningRunCount ?? 0) > 0).refetchInterval,
  });

export { overviewsQueryOptions, projectOverviewQueryOptions };
