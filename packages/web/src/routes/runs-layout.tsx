import type { ReactNode } from 'react';
import { Outlet, useParams, useSearch } from '@tanstack/react-router';
import { useRuns } from '../api/queries.js';
import { RunList } from '../components/runs/run-list.js';

/**
 * Keeps run navigation available on every page. Reads search loosely because the root
 * not-found page renders it outside the workspace route.
 */
const RunsLayout = ({ children = <Outlet /> }: { children?: ReactNode }) => {
  const runsQuery = useRuns();
  const { runId, candidateRunId } = useParams({ strict: false });
  const { branch, label } = useSearch({ strict: false });

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
      <main className="main-content">{children}</main>
    </div>
  );
};

export { RunsLayout };
