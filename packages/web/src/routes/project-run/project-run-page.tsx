import { getRouteApi, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import { runQueryOptions, runSuitesQueryOptions } from '../../api/queries/runs.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { RunLifecycle } from '../../components/marks/run-lifecycle.js';
import { ProportionMeter } from '../../components/meters/proportion-meter.js';
import { formatCount, formatStarted, shortRunId } from '../../lib/format.js';
import { CancelRun } from '../eval-run/cancel-run.js';
import { runHeadline } from '../eval-run/run-verdict.js';
import '../../styles/compact/pages.css';
import '../../styles/compact/runs.css';

const route = getRouteApi('/projects/$projectKey/runs/$runId');

/**
 * A run that spans several evals, or none recorded yet. Cloud upload responses link here; a run
 * with a single eval never renders this page because the route redirects to that eval's run page.
 */
const ProjectRunPage = () => {
  const { projectKey, runId } = route.useParams();
  const source = useDashboardSource();

  useLiveProjectOverview(source, projectKey);

  const run = useQuery(runQueryOptions(source, projectKey, runId));
  const running = run.data?.status === 'running';
  const suites = useQuery(runSuitesQueryOptions(source, projectKey, runId, running));

  if (run.data === undefined)
    return run.error === null ? (
      <p className="attest-loading" role="status">
        Loading run {shortRunId(runId)}...
      </p>
    ) : (
      <EmptyState title="Could not load this run" description={run.error.message} />
    );

  const evals = suites.data?.suites ?? [];

  return (
    <>
      <div className="attest-page-head">
        <div className="attest-page-title">
          <h1 className="attest-run-title">
            <span className="attest-mono" title={run.data.id}>
              Run {shortRunId(run.data.id)}
            </span>
            <RunLifecycle status={run.data.status} />
          </h1>
          <p className="attest-sub">
            {formatStarted(run.data.createdAt)}
            {evals.length > 0 && `, ${formatCount(evals.length, 'eval')}`}
          </p>
        </div>
        <div className="attest-page-end">
          <CancelRun projectKey={projectKey} run={run.data} evalCount={evals.length} />
        </div>
      </div>
      {suites.data === undefined ? (
        suites.error === null ? (
          <p className="attest-loading" role="status">
            Loading the evals in this run...
          </p>
        ) : (
          <EmptyState title="Could not load this run's evals" description={suites.error.message} />
        )
      ) : evals.length === 0 ? (
        <EmptyState
          title="No eval results yet"
          description={
            running
              ? 'Each eval shows up here once the run records its first case.'
              : 'This run finished without recording a case.'
          }
        />
      ) : (
        <section className="attest-card" aria-label="Evals in this run">
          <table className="attest-table">
            <thead>
              <tr>
                <th scope="col">Eval</th>
                <th scope="col">Result</th>
                <th scope="col">Cases</th>
              </tr>
            </thead>
            <tbody>
              {evals.map((slice) => (
                <tr key={slice.suiteName}>
                  <td>
                    <Link
                      className="attest-rowlink"
                      to="/projects/$projectKey/evals/$suiteName/runs/$runId"
                      params={{ projectKey, suiteName: slice.suiteName, runId }}
                    >
                      {slice.suiteName}
                    </Link>
                  </td>
                  <td className="attest-nw">{runHeadline(slice)}</td>
                  <td>
                    <ProportionMeter counts={slice.counts} label={slice.suiteName} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
};

export { ProjectRunPage };
