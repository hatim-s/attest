import { getRouteApi, Navigate } from '@tanstack/react-router';
import { useRuns } from '../api/queries.js';

const route = getRouteApi('/projects/$projectKey/runs/');

/** Also redirects when polling discovers the first run after an empty initial load. */
const NewestRun = () => {
  const { projectKey } = route.useParams();
  const runsQuery = useRuns(projectKey);
  const newest = runsQuery.data?.[0];
  const search = route.useSearch();

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
        Run <code>attest eval run</code>. The run shows up here as soon as it starts.
      </p>
    </div>
  );
};

export { NewestRun };
