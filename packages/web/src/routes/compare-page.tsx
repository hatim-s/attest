import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useDiff, useRun, useRuns } from '../api/queries.js';
import { DiffPanel } from '../components/cases/diff-panel.js';
import { ErrorNotice, Loading } from '../components/shared/ui.js';
import { RunOverview } from './run-overview.js';

const route = getRouteApi('/compare/$baseRunId/$candidateRunId');

/** Makes a comparison reproducible from its baseline and candidate identities. */
const ComparePage = () => {
  const { baseRunId, candidateRunId } = route.useParams();
  const navigate = useNavigate();
  const runsQuery = useRuns();
  const baseQuery = useRun(baseRunId);
  const candidateQuery = useRun(candidateRunId);

  const diffQuery = useDiff({
    baseRunId,
    candidateRunId,
    baseStatus: baseQuery.data?.status,
    candidateStatus: candidateQuery.data?.status,
    visible: true,
  });

  return (
    <>
      {candidateQuery.isLoading ? <Loading label="Loading run" /> : null}
      {candidateQuery.error !== null ? <ErrorNotice error={candidateQuery.error} /> : null}
      {candidateQuery.data !== undefined ? (
        <RunOverview run={candidateQuery.data} tab="compare" />
      ) : null}
      <DiffPanel
        key={`${baseRunId}:${candidateRunId}`}
        baseRunId={baseRunId}
        candidateRunId={candidateRunId}
        diff={diffQuery.data}
        error={diffQuery.error}
        isLoading={diffQuery.isLoading}
        runs={runsQuery.data ?? []}
        onBaseChange={(nextBaseRunId) =>
          void navigate({
            to: '/compare/$baseRunId/$candidateRunId',
            params: { baseRunId: nextBaseRunId, candidateRunId },
          })
        }
      />
    </>
  );
};

export { ComparePage };
