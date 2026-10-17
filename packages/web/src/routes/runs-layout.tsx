import { getRouteApi, Outlet, useParams } from '@tanstack/react-router';
import { useRuns } from '../api/queries.js';
import { RunList } from '../components/runs/run-list.js';

const route = getRouteApi('/workspace');

/** Keeps run navigation available on both run and comparison pages. */
const RunsLayout = () => {
  const runsQuery = useRuns();
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
