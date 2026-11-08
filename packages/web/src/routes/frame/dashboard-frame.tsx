import { Outlet, useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useDashboardSource } from '../../api/api-client-context.js';
import { overviewsQueryOptions } from '../../api/queries/projects.js';
import { evalsQueryOptions } from '../../api/queries/evals.js';
import { CompactShell } from '../../shell/compact-shell.js';
import { breadcrumbsFor, targetLink } from './shell-targets.js';
import { navigationData, recentLabel, shellEvals, shellProjects } from './shell-data.js';
import { useCurrentTarget } from './use-current-target.js';
import { useTargetHref } from './use-target-href.js';

/**
 * Root layout for every route. The sidebar reads the catalog overview and, for the open project
 * only, its eval list; both queries carry the source they came from.
 */
const DashboardFrame = () => {
  const source = useDashboardSource();
  const router = useRouter();
  const hrefFor = useTargetHref();
  const current = useCurrentTarget(source.id);
  const projectKey = current.kind === 'projects' ? undefined : current.projectKey;
  const overviews = useQuery(overviewsQueryOptions(source));

  const entry = overviews.data?.items.find((item) => item.project.key === projectKey);
  const running = entry?.status === 'ready' && entry.overview.runningRunCount > 0;

  const evals = useQuery({
    ...evalsQueryOptions(source, projectKey ?? '', running),
    enabled: projectKey !== undefined,
  });

  return (
    <CompactShell
      source={source}
      sources={[source]}
      projects={{ sourceId: source.id, state: navigationData(overviews, shellProjects) }}
      evals={
        projectKey === undefined
          ? null
          : { sourceId: source.id, projectKey, state: navigationData(evals, shellEvals) }
      }
      current={current}
      breadcrumbs={breadcrumbsFor(current, {
        project: (key) =>
          overviews.data?.items.find((item) => item.project.key === key)?.project.name ?? key,
      })}
      hrefFor={hrefFor}
      onNavigate={(target) => void router.navigate(targetLink(target))}
      // One source per host: there is nothing to switch to.
      onSourceChange={() => {}}
      resolveRecent={(target) => recentLabel(overviews.data, target)}
    >
      <Outlet />
    </CompactShell>
  );
};

export { DashboardFrame };
