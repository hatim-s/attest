import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { DashboardSource } from '../../api/dashboard-source.js';
import { caseWindowQueryOptions } from '../../api/queries/cases.js';

type WindowNeighbours = {
  /** The case's place in case id order; undefined until a loaded page holds it. */
  position: number | undefined;
  /** How many cases the eval has; undefined while more pages remain. */
  total: number | undefined;
  previous: string | undefined;
  next: string | undefined;
};

/**
 * Previous and Next in the Test cases tab's order. It shares the tab's cached pages. While the case
 * is missing from them, or is the last loaded one, the next page is read, so a direct link finds
 * its place and Next is known at a page boundary. A failed page read stops the walk.
 */
const useWindowNeighbours = (
  source: DashboardSource,
  projectKey: string,
  suiteName: string,
  caseId: string,
): WindowNeighbours => {
  const cases = useInfiniteQuery(caseWindowQueryOptions(source, projectKey, suiteName));
  const ids = cases.data?.pages.flatMap((page) => page.items.map((item) => item.caseId)) ?? [];
  const index = ids.indexOf(caseId);
  const walk = cases.data !== undefined && (index === -1 || index === ids.length - 1);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = cases;

  useEffect(() => {
    if (walk && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [walk, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const total = cases.data === undefined || hasNextPage ? undefined : ids.length;

  if (index === -1) return { position: undefined, total, previous: undefined, next: undefined };

  return { position: index + 1, total, previous: ids[index - 1], next: ids[index + 1] };
};

export { useWindowNeighbours };
