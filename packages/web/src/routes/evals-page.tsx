import { Link } from '@tanstack/react-router';
import { useNewestCompletedRun, useRunSuites } from '../api/queries.js';
import { SuiteTable } from '../components/runs/suite-table.js';
import { ErrorNotice, Loading } from '../components/shared/ui.js';
import { shortId } from '../lib/format.js';

/** Uses a finished run so the catalog does not fluctuate as suites start executing. */
const EvalsPage = () => {
  const runQuery = useNewestCompletedRun();
  const run = runQuery.data;
  const suitesQuery = useRunSuites(run?.id, run?.status);

  return (
    <section aria-label="Evals">
      <h1>Evals</h1>
      {runQuery.isLoading || suitesQuery.isLoading ? <Loading label="Loading evals" /> : null}
      {runQuery.error !== null ? <ErrorNotice error={runQuery.error} /> : null}
      {suitesQuery.error !== null ? <ErrorNotice error={suitesQuery.error} /> : null}
      {run === null ? <p className="empty-compact">No finished runs yet.</p> : null}
      {run !== undefined && run !== null ? (
        <p className="empty-compact">
          Suites in{' '}
          <Link
            to="/runs/$runId"
            params={{ runId: run.id }}
            search={(previous) => ({ ...previous, tab: 'suites' })}
            title={run.id}
          >
            run {shortId(run.id)}
          </Link>
          , the newest finished run.
        </p>
      ) : null}
      {suitesQuery.data !== undefined ? <SuiteTable suites={suitesQuery.data.suites} /> : null}
    </section>
  );
};

export { EvalsPage };
