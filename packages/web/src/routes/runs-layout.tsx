import { useState } from 'react';
import { getRouteApi, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useApiClient } from '../api/api-client-context.js';
import { useRuns } from '../api/queries.js';
import { RunList } from '../components/runs/run-list.js';
import { Button } from '../components/shared/ui.js';
import { NewRunDrawer } from './new-run-drawer.js';

const route = getRouteApi('/projects/$projectKey');

/**
 * Keeps the project's run navigation available on every workspace page. Hosts that can start runs
 * get a New run button; static reports and the cloud host do not.
 */
const RunsLayout = () => {
  const { projectKey } = route.useParams();
  const { capabilities } = useApiClient();
  const navigate = useNavigate();
  const [isNewRunOpen, setNewRunOpen] = useState(false);
  const runsQuery = useRuns(projectKey);
  const { runId, candidateRunId } = useParams({ strict: false });
  const { branch, label } = route.useSearch();

  const runs = (runsQuery.data?.items ?? []).filter(
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
        action={
          capabilities.control ? (
            <Button tone="primary" onClick={() => setNewRunOpen(true)}>
              New run
            </Button>
          ) : null
        }
      />
      <main className="main-content">
        <Outlet />
      </main>
      {isNewRunOpen ? (
        <NewRunDrawer
          projectKey={projectKey}
          onClose={() => setNewRunOpen(false)}
          onStarted={(startedRunId) => {
            setNewRunOpen(false);
            void navigate({
              to: '/projects/$projectKey/runs/$runId',
              params: { projectKey, runId: startedRunId },
              search: { tab: 'cases' },
            });
          }}
        />
      ) : null}
    </div>
  );
};

export { RunsLayout };
