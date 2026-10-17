import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { useNewestCompletedRun, useRunSuites } from '../api/queries.js';
import { SuiteTable } from '../components/runs/suite-table.js';
import { ErrorNotice, Heading, Loading } from '../components/shared/ui.js';
import { formatDateTime, shortId } from '../lib/format.js';

const SourceRun = ({ run }: { run: RunRecord }) => (
  <>
    From{' '}
    <Link
      to="/runs/$runId"
      params={{ runId: run.id }}
      search={({ branch, label }) => ({ branch, label, tab: 'suites' })}
      title={run.id}
    >
      run {shortId(run.id)}
    </Link>
    , the newest finished run, started {formatDateTime(run.createdAt)}
  </>
);

/** Uses a finished run so the catalog does not fluctuate as suites start executing. */
const EvalsPage = () => {
  const runQuery = useNewestCompletedRun();
  const run = runQuery.data;
  const suitesQuery = useRunSuites(run?.id, run?.status);
  const meta = run === null ? 'No finished runs yet.' : run && <SourceRun run={run} />;

  return (
    <section className="stack" aria-label="Evals">
      <Heading level={1} eyebrow="Evals" title="Suites" meta={meta} />
      {runQuery.isLoading || suitesQuery.isLoading ? <Loading label="Loading evals" /> : null}
      {runQuery.error !== null ? <ErrorNotice error={runQuery.error} /> : null}
      {suitesQuery.error !== null ? <ErrorNotice error={suitesQuery.error} /> : null}
      {suitesQuery.data !== undefined ? <SuiteTable suites={suitesQuery.data.suites} /> : null}
    </section>
  );
};

export { EvalsPage };
