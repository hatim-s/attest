import * as Effect from 'effect/Effect';
import { queryOptions } from '@tanstack/react-query';
import type { ActivityQuery } from '@attest/api/contract';
import type { DashboardSource } from '../dashboard-source.js';
import { queryKeys } from '../query-keys.js';
import { refreshPolicy } from './refresh.js';

/** UTC daily case counts across every eval of a project in `[from, to)`. */
const activityQueryOptions = (source: DashboardSource, projectKey: string, query: ActivityQuery) =>
  queryOptions({
    queryKey: queryKeys.activity({ sourceId: source.id, projectKey }, query),
    queryFn: ({ signal }) =>
      Effect.runPromise(source.client.getActivity({ projectKey }, query, { signal })),
    ...refreshPolicy(source, false),
  });

export { activityQueryOptions };
