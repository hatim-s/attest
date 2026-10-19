import { useEffect, useMemo } from 'react';
import type { RunRecord } from '@attest/core/records';
import { useCases, useRuns } from '../../api/queries.js';
import { useProjectKey } from '../../routes/use-project-key.js';
import { Button, ErrorNotice, Loading } from '../shared/ui.js';
import { DistributionCharts } from './distribution-charts.js';
import { DurationDistribution } from './duration-distribution.js';
import { MetricErrorCases } from './metric-error-cases.js';
import { RunTrends } from './run-trends.js';

/** Pages through every case while open, since a histogram of the first page would misstate the run. */
const RunDistributions = ({ run }: { run: RunRecord }) => {
  const projectKey = useProjectKey();
  const casesQuery = useCases(projectKey, run.id, run.status);
  const runsQuery = useRuns(projectKey);

  const cases = useMemo(
    () => casesQuery.data?.pages.flatMap((page) => page.items),
    [casesQuery.data],
  );

  // Empty charts mean an empty run only once no page remains outstanding.
  const allLoaded = !casesQuery.hasNextPage;

  useEffect(() => {
    if (casesQuery.hasNextPage && !casesQuery.isFetching && !casesQuery.isFetchNextPageError) {
      void casesQuery.fetchNextPage();
    }
  }, [casesQuery]);

  return (
    <section className="stack" aria-label="Distributions">
      {casesQuery.error !== null ? <ErrorNotice error={casesQuery.error} /> : null}
      {casesQuery.isFetchNextPageError ? (
        <Button onClick={() => void casesQuery.fetchNextPage()}>Retry loading cases</Button>
      ) : null}
      {cases === undefined ? (
        casesQuery.isError ? (
          <Button onClick={() => void casesQuery.refetch()}>Retry loading cases</Button>
        ) : (
          <Loading label="Loading cases" />
        )
      ) : (
        <>
          <DistributionCharts
            cases={cases}
            allLoaded={allLoaded}
            isLoading={casesQuery.isFetching}
            totalCases={run.summary?.totalCases ?? cases.length}
          />
          {run.status === 'running' ? (
            <p className="empty-compact">Still running. Charts cover the cases finished so far.</p>
          ) : null}
          <DurationDistribution cases={cases} allLoaded={allLoaded} />
          <MetricErrorCases cases={cases} allLoaded={allLoaded} runId={run.id} />
        </>
      )}
      {runsQuery.error !== null ? <ErrorNotice error={runsQuery.error} /> : null}
      {runsQuery.data !== undefined ? (
        <RunTrends runs={runsQuery.data.items} />
      ) : runsQuery.isPending ? (
        <Loading label="Loading recent runs" />
      ) : null}
    </section>
  );
};

export { RunDistributions };
