import { Outlet, useMatch } from '@tanstack/react-router';
import { useRuns } from '../api/queries.js';
import { RunList } from '../components/runs/run-list.js';

/** Keeps run navigation available on both run and comparison pages. */
const RunsLayout = () => {
  const runsQuery = useRuns();
  const runMatch = useMatch({ from: '/runs/$runId', shouldThrow: false });

  const compareMatch = useMatch({
    from: '/compare/$baseRunId/$candidateRunId',
    shouldThrow: false,
  });

  const runsMatch = useMatch({ from: '/runs', shouldThrow: false });
  const { branch, label } = runsMatch?.search ?? {};

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
        selectedRunId={runMatch?.params.runId ?? compareMatch?.params.candidateRunId}
      />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
};

export { RunsLayout };
