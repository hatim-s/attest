import { useEffect } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useRuns } from '../api/queries.js';

const route = getRouteApi('/runs/');

/** Also redirects when polling discovers the first run after an empty initial load. */
const NewestRun = () => {
  const runsQuery = useRuns();
  const newest = runsQuery.data?.[0];
  const search = route.useSearch();
  const navigate = useNavigate();
  useEffect(() => {
    if (newest !== undefined) {
      void navigate({
        to: '/runs/$runId',
        params: { runId: newest.id },
        search: { ...search, tab: 'cases' },
        replace: true,
      });
    }
  }, [navigate, newest, search]);

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
