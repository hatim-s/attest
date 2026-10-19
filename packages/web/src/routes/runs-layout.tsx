import { getRouteApi, Outlet, useParams } from '@tanstack/react-router';
import { useRuns } from '../api/queries.js';
import { RunList } from '../components/runs/run-list.js';

const route = getRouteApi('/projects/$projectKey');

/** Keeps the project's run navigation available on every workspace page. */
const RunsLayout = () => {
  const { projectKey } = route.useParams();
  const runsQuery = useRuns(projectKey);
  const { runId, candidateRunId } = useParams({ strict: false });
  const { branch, label } = route.useSearch();

  const runs = (runsQuery.data ?? []).filter(
    (run) =>
      (branch === undefined || run.gitBranch === branch) &&
      (label === undefined ||
        Object.entries(run.labels ?? {}).some(([key, value]) => label === `${key}=${value}`)),
  );

  return (
    <div className="workspace">
      <RunList
        error={runsQuery.error}
        isLoading={runsQuery.isLoading}
        projectKey={projectKey}
        runs={runs}
        selectedRunId={runId ?? candidateRunId}
      />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
};

export { RunsLayout };
