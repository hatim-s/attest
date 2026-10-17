import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useCase, useRun, useCases } from '../api/queries.js';
import { CaseDetail } from '../components/cases/case-detail.js';

const route = getRouteApi('/runs/$runId/cases/$suiteName/$caseId');

/** Loads deep-linked evidence without depending on a previously loaded case page. */
const CaseDrawer = () => {
  const { runId, suiteName, caseId } = route.useParams();
  const navigate = useNavigate();
  const runQuery = useRun(runId);
  const casesQuery = useCases(runId, runQuery.data?.status);

  const summary = casesQuery.data?.pages
    .flatMap((page) => page.items)
    .find((item) => item.suiteName === suiteName && item.caseId === caseId);

  const caseQuery = useCase({ runId, suiteName, caseId, status: runQuery.data?.status });

  return (
    <CaseDetail
      key={`${runId}:${suiteName}:${caseId}`}
      caseRecord={caseQuery.data}
      error={caseQuery.error}
      isLoading={caseQuery.isLoading}
      selected={summary ?? { suiteName, caseId }}
      onClose={() =>
        void navigate({
          to: '/runs/$runId',
          params: { runId },
          search: (previous) => ({ ...previous, tab: previous.tab ?? 'cases' }),
        })
      }
    />
  );
};

export { CaseDrawer };
