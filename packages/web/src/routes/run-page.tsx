import { useEffect } from 'react';
import { getRouteApi, Outlet } from '@tanstack/react-router';
import { useRun, useCases } from '../api/queries.js';
import { CaseTable } from '../components/cases/case-table.js';
import { DistributionCharts } from '../components/runs/distribution-charts.js';
import { ErrorNotice, Loading } from '../components/shared/ui.js';
import { RunOverview } from './run-overview.js';

const route = getRouteApi('/runs/$runId');

/** Keeps case paging and distribution loading scoped to the URL's run. */
const RunPage = () => {
  const { runId } = route.useParams();
  const { tab } = route.useSearch();
  const runQuery = useRun(runId);
  const casesQuery = useCases(runId, runQuery.data?.status);
  const cases = casesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    if (
      tab === 'distributions' &&
      casesQuery.hasNextPage &&
      !casesQuery.isFetching &&
      !casesQuery.isFetchNextPageError
    ) {
      void casesQuery.fetchNextPage();
    }
  }, [casesQuery, tab]);
  const run = runQuery.data;

  return (
    <>
      {runQuery.isLoading ? <Loading label="Loading run" /> : null}
      {runQuery.error !== null ? <ErrorNotice error={runQuery.error} /> : null}
      {run !== undefined ? (
        <>
          <RunOverview run={run} tab={tab} />
          {tab === 'cases' ? (
            <section aria-label="Cases">
              {casesQuery.isLoading ? <Loading label="Loading cases" /> : null}
              {casesQuery.error !== null ? <ErrorNotice error={casesQuery.error} /> : null}
              {cases.length > 0 ? (
                <CaseTable
                  cases={cases}
                  hasNextPage={casesQuery.hasNextPage}
                  isFetchingNextPage={casesQuery.isFetchingNextPage}
                  onLoadMore={() => void casesQuery.fetchNextPage()}
                  runId={runId}
                />
              ) : null}
              {!casesQuery.isLoading && cases.length === 0 ? (
                <div className="empty-compact">This run has no recorded cases.</div>
              ) : null}
            </section>
          ) : null}
          {tab === 'distributions' ? (
            <>
              {casesQuery.error !== null ? <ErrorNotice error={casesQuery.error} /> : null}
              <DistributionCharts
                cases={cases}
                isLoading={casesQuery.isFetching}
                totalCases={run.summary?.totalCases ?? cases.length}
              />
            </>
          ) : null}
        </>
      ) : null}
      <Outlet />
    </>
  );
};

export { RunPage };
