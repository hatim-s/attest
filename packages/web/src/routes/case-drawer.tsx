import { getRouteApi, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useCase, useRun } from '../api/queries.js';
import { CaseDetail } from '../components/cases/case-detail.js';

const route = getRouteApi('/projects/$projectKey/runs/$runId/cases/$suiteName/$caseId');

/**
 * Loads deep-linked evidence without depending on a previously loaded case page. Closing goes
 * back when the run page opened the drawer, so Back after Close does not reopen the case.
 */
const CaseDrawer = () => {
  const { projectKey, runId, suiteName, caseId } = route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const openedFromRun = useLocation({ select: (location) => location.state.caseOpenedFromRun });
  const runQuery = useRun(projectKey, runId);

  const caseQuery = useCase(projectKey, {
    runId,
    suiteName,
    caseId,
    status: runQuery.data?.status,
  });

  return (
    <CaseDetail
      key={`${runId}:${suiteName}:${caseId}`}
      caseRecord={caseQuery.data}
      error={caseQuery.error}
      isLoading={caseQuery.isLoading}
      selected={{ suiteName, caseId }}
      onClose={() => {
        if (openedFromRun === true) {
          router.history.back();

          return;
        }

        void navigate({
          to: '/projects/$projectKey/runs/$runId',
          params: { projectKey, runId },
          search: (previous) => previous,
        });
      }}
    />
  );
};

export { CaseDrawer };
