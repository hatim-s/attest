import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useCase, useRun } from '../api/queries.js';
import { CaseDetail } from '../components/cases/case-detail.js';

const route = getRouteApi('/workspace/runs/$runId/cases/$suiteName/$caseId');

/** Loads deep-linked evidence without depending on a previously loaded case page. */
const CaseDrawer = () => {
  const { runId, suiteName, caseId } = route.useParams();
  const navigate = useNavigate();
  const runQuery = useRun(runId);
  const caseQuery = useCase({ runId, suiteName, caseId, status: runQuery.data?.status });

  return (
    <CaseDetail
      key={`${runId}:${suiteName}:${caseId}`}
      caseRecord={caseQuery.data}
      error={caseQuery.error}
      isLoading={caseQuery.isLoading}
      selected={{ suiteName, caseId }}
      onClose={() =>
        void navigate({
          to: '/runs/$runId',
          params: { runId },
          search: (previous) => previous,
        })
      }
    />
  );
};

export { CaseDrawer };
