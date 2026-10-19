import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useDiff, useRun, useRuns } from '../api/queries.js';
import { DiffPanel } from '../components/cases/diff-panel.js';
import { ErrorNotice, Loading } from '../components/shared/ui.js';
import { RunHeader } from '../components/runs/run-header.js';
import { RunTabs } from '../components/runs/run-tabs.js';

const route = getRouteApi('/projects/$projectKey/compare/$baseRunId/$candidateRunId');

/** Makes a comparison reproducible from its baseline and candidate identities. */
const ComparePage = () => {
  const { projectKey, baseRunId, candidateRunId } = route.useParams();
  const navigate = useNavigate();
  const runsQuery = useRuns(projectKey);
  const baseQuery = useRun(projectKey, baseRunId);
  const candidateQuery = useRun(projectKey, candidateRunId);

  const diffQuery = useDiff(projectKey, {
    baseRunId,
    candidateRunId,
    baseStatus: baseQuery.data?.status,
    candidateStatus: candidateQuery.data?.status,
  });

  return (
    <>
      {candidateQuery.isLoading ? <Loading label="Loading run" /> : null}
      {candidateQuery.error !== null ? <ErrorNotice error={candidateQuery.error} /> : null}
      {candidateQuery.data !== undefined ? (
        <>
          <RunHeader run={candidateQuery.data} />
          <RunTabs run={candidateQuery.data} tab="compare" />
        </>
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
            to: '/projects/$projectKey/compare/$baseRunId/$candidateRunId',
            params: { projectKey, baseRunId: nextBaseRunId, candidateRunId },
            search: (previous) => previous,
          })
        }
      />
    </>
  );
};

export { ComparePage };
