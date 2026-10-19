import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { useNewestCompletedRun, useRunSuites } from '../api/queries.js';
import { SuiteTable } from '../components/runs/suite-table.js';
import { ErrorNotice, Heading, Loading } from '../components/shared/ui.js';
import { formatDateTime, shortId } from '../lib/format.js';
import { useProjectKey } from './use-project-key.js';

const SourceRun = ({ projectKey, run }: { projectKey: string; run: RunRecord }) => (
  <>
    From{' '}
    <Link
      to="/projects/$projectKey/runs/$runId"
      params={{ projectKey, runId: run.id }}
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
  const projectKey = useProjectKey();
  const runQuery = useNewestCompletedRun(projectKey);
  const run = runQuery.data;
  const suitesQuery = useRunSuites(projectKey, run?.id, run?.status);

  const meta =
    run === null ? 'No finished runs yet.' : run && <SourceRun projectKey={projectKey} run={run} />;

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
