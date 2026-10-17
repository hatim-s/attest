import { useEffect, useMemo } from 'react';
import type { RunRecord } from '@attest/core/records';
import { useCases, useRuns } from '../../api/queries.js';
import { Button, ErrorNotice } from '../shared/ui.js';
import { DistributionCharts } from './distribution-charts.js';
import { DurationDistribution } from './duration-distribution.js';
import { MetricErrorCases } from './metric-error-cases.js';
import { RunTrends } from './run-trends.js';

/** Pages through every case while open, since a histogram of the first page would misstate the run. */
const RunDistributions = ({ run }: { run: RunRecord }) => {
  const casesQuery = useCases(run.id, run.status);
  const runsQuery = useRuns();

  const cases = useMemo(
    () => casesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [casesQuery.data],
  );

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
      <DistributionCharts
        cases={cases}
        isLoading={casesQuery.isFetching}
        totalCases={run.summary?.totalCases ?? cases.length}
      />
      {run.status === 'running' ? (
        <p className="empty-compact">Still running. Charts cover the cases finished so far.</p>
      ) : null}
      <DurationDistribution cases={cases} />
      <MetricErrorCases cases={cases} runId={run.id} />
      {runsQuery.error !== null ? <ErrorNotice error={runsQuery.error} /> : null}
      <RunTrends runs={runsQuery.data ?? []} />
    </section>
  );
};

export { RunDistributions };
