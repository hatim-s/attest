import { getRouteApi, Navigate } from '@tanstack/react-router';
import { useRuns } from '../api/queries.js';

const route = getRouteApi('/workspace/runs/');

/** Also redirects when polling discovers the first run after an empty initial load. */
const NewestRun = () => {
  const runsQuery = useRuns();
  const newest = runsQuery.data?.[0];
  const search = route.useSearch();

  if (newest !== undefined) {
    return <Navigate to="/runs/$runId" params={{ runId: newest.id }} search={search} replace />;
  }

  return (
    <div className="card welcome-card">
      <p className="eyebrow">Ready</p>
      <h1>Run your first evaluation</h1>
      <p>
        Use <code>attest eval run</code>, then this view will update automatically.
      </p>
    </div>
  );
};

export { NewestRun };
