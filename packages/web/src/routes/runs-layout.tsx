import { Outlet, useMatch, useNavigate } from '@tanstack/react-router';
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

  const navigate = useNavigate();

  return (
    <div className="workspace">
      <RunList
        error={runsQuery.error}
        isLoading={runsQuery.isLoading}
        runs={runsQuery.data ?? []}
        selectedRunId={runMatch?.params.runId ?? compareMatch?.params.candidateRunId}
        onSelect={(runId) =>
          void navigate({ to: '/runs/$runId', params: { runId }, search: { tab: 'cases' } })
        }
      />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
};

export { RunsLayout };
