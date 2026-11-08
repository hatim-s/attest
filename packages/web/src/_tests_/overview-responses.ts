import type { ProjectOverviewList } from '@attest/api/contract';
import type { ProjectRecord, ProjectRunOverview } from '@attest/core/records';

/** An overview with no recorded eval slices, as a store with no runs reports it. */
const emptyOverview = {
  evals: { items: [] },
  runningRunCount: 0,
  runningRunCountTruncated: false,
  lastRunAt: null,
} satisfies ProjectRunOverview;

/**
 * Answers the reads the shell makes on every page: the catalog overview, one project's overview
 * and its eval list. Returns undefined for any other path so the caller's own routes apply.
 */
const overviewResponse = (path: string, projects: readonly ProjectRecord[]) => {
  if (path.endsWith('/api/overview'))
    return Response.json({
      items: projects.map((project) => ({ status: 'ready', project, overview: emptyOverview })),
    } satisfies ProjectOverviewList);

  const key = /\/api\/projects\/([^/]+)\/(overview|evals)$/.exec(path);

  if (key === null) return undefined;

  if (!projects.some((project) => project.key === key[1]))
    return Response.json(
      { error: { code: 'PROJECT_NOT_FOUND', message: `Project ${key[1]} was not found.` } },
      { status: 404 },
    );

  return Response.json(key[2] === 'overview' ? emptyOverview : emptyOverview.evals);
};

export { overviewResponse };
