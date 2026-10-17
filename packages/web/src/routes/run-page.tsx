import { useMemo } from 'react';
import { getRouteApi, Outlet } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { useRun, useCases, useRunSuites } from '../api/queries.js';
import { SuiteTable } from '../components/runs/suite-table.js';
import { CaseTable } from '../components/cases/case-table.js';
import { RunDistributions } from '../components/runs/run-distributions.js';
import { ErrorNotice, Loading } from '../components/shared/ui.js';
import { RunHeader } from '../components/runs/run-header.js';
import { RunTabs } from '../components/runs/run-tabs.js';

const route = getRouteApi('/workspace/runs/$runId');

/** Loads one page of cases at a time; the table asks for more as the reader scrolls. */
const RunCases = ({ run }: { run: RunRecord }) => {
  const casesQuery = useCases(run.id, run.status);

  const cases = useMemo(
    () => casesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [casesQuery.data],
  );

  return (
    <section aria-label="Cases">
      {casesQuery.isLoading ? <Loading label="Loading cases" /> : null}
      {casesQuery.error !== null ? <ErrorNotice error={casesQuery.error} /> : null}
      {cases.length > 0 ? (
        <CaseTable
          cases={cases}
          hasNextPage={casesQuery.hasNextPage}
          isFetchingNextPage={casesQuery.isFetchingNextPage}
          onLoadMore={() => void casesQuery.fetchNextPage()}
          runId={run.id}
        />
      ) : null}
      {!casesQuery.isLoading && cases.length === 0 ? (
        <div className="empty-compact">This run has no recorded cases.</div>
      ) : null}
    </section>
  );
};

/** Server aggregates cover every case, so this tab never pages cases itself. */
const RunSuites = ({ run }: { run: RunRecord }) => {
  const suitesQuery = useRunSuites(run.id, run.status);

  return (
    <section aria-label="Suites">
      {run.status === 'running' ? (
        <p className="empty-compact">This run is running. Suite numbers are partial.</p>
      ) : null}
      {suitesQuery.isLoading ? <Loading label="Loading suites" /> : null}
      {suitesQuery.error !== null ? <ErrorNotice error={suitesQuery.error} /> : null}
      {suitesQuery.data !== undefined ? <SuiteTable suites={suitesQuery.data.suites} /> : null}
    </section>
  );
};

/** Each tab owns its queries, so a tab the reader has not opened fetches nothing. */
const RunPage = () => {
  const { runId } = route.useParams();
  const { tab } = route.useSearch();
  const runQuery = useRun(runId);
  const run = runQuery.data;

  return (
    <>
      {runQuery.isLoading ? <Loading label="Loading run" /> : null}
      {runQuery.error !== null ? <ErrorNotice error={runQuery.error} /> : null}
      {run !== undefined ? (
        <>
          <RunHeader run={run} />
          <RunTabs run={run} tab={tab} />
          {tab === 'cases' ? <RunCases run={run} /> : null}
          {tab === 'suites' ? <RunSuites run={run} /> : null}
          {tab === 'distributions' ? <RunDistributions run={run} /> : null}
        </>
      ) : null}
      <Outlet />
    </>
  );
};

export { RunPage };
