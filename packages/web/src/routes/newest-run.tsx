import { getRouteApi, Navigate } from '@tanstack/react-router';
import { useApiClient } from '../api/api-client-context.js';
import { useRuns } from '../api/queries.js';

const route = getRouteApi('/projects/$projectKey/runs/');

/** Also redirects when polling discovers the first run after an empty initial load. */
const NewestRun = () => {
  const { projectKey } = route.useParams();
  const runsQuery = useRuns(projectKey);
  const newest = runsQuery.data?.items[0];
  const search = route.useSearch();
  const { capabilities } = useApiClient();

  if (newest !== undefined) {
    return (
      <Navigate
        to="/projects/$projectKey/runs/$runId"
        params={{ projectKey, runId: newest.id }}
        search={search}
        replace
      />
    );
  }

  return (
    <div className="card welcome-card">
      <p className="eyebrow">Ready</p>
      <h1>Run your first evaluation</h1>
      <p>
        {capabilities.control ? 'Use New run in the sidebar, or run ' : 'Run '}
        <code>attest eval run</code> in the project. The run shows up here as soon as it starts.
      </p>
    </div>
  );
};

export { NewestRun };
