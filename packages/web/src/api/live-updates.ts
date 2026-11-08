import { useEffect, useRef } from 'react';
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectRunOverview } from '@attest/core/records';
import type { DashboardSource } from './dashboard-source.js';
import { projectOverviewQueryOptions } from './queries/projects.js';
import { queryKeys, type ProjectScope } from './query-keys.js';

/**
 * The project's trend, table and activity reads do not poll. When the polled overview reports a
 * run starting (`lastRunAt`) or finishing (`runningRunCount`), every other read of that project is
 * invalidated by key prefix, so open pages pick up the change once instead of on a timer.
 */
const useProjectChangeSignal = (
  { sourceId, projectKey }: ProjectScope,
  overview: ProjectRunOverview | undefined,
) => {
  const queryClient = useQueryClient();

  const signal =
    overview === undefined ? undefined : `${overview.lastRunAt}:${overview.runningRunCount}`;

  const seen = useRef<{ owner: string; signal: string }>(undefined);

  useEffect(() => {
    if (signal === undefined) return;
    const scope = { sourceId, projectKey };
    const owner = hashKey(queryKeys.project(scope));
    const overviewHash = hashKey(queryKeys.projectOverview(scope));
    const previous = seen.current;
    seen.current = { owner, signal };

    // The first reading of a project, or a switch to another project, is not a change.
    if (previous?.owner !== owner || previous.signal === signal) return;

    void queryClient.invalidateQueries({
      queryKey: queryKeys.project(scope),
      predicate: (query) => query.queryHash !== overviewHash,
    });
  }, [projectKey, queryClient, signal, sourceId]);
};

/**
 * The project's overview, subscribed so it polls while a run executes, with the change signal
 * attached. Every project page calls this once so its other reads refresh when a run starts or
 * finishes.
 */
const useLiveProjectOverview = (source: DashboardSource, projectKey: string) => {
  const overview = useQuery(projectOverviewQueryOptions(source, projectKey));

  useProjectChangeSignal({ sourceId: source.id, projectKey }, overview.data);

  return overview;
};

export { useLiveProjectOverview };
