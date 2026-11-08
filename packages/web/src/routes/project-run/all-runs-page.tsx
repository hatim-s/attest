import { getRouteApi, Link } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { RunRecord } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import { projectRunsQueryOptions } from '../../api/queries/runs.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { RunLifecycle } from '../../components/marks/run-lifecycle.js';
import { formatStarted, shortRunId } from '../../lib/format.js';
import { NewRunButton } from '../new-run/new-run-button.js';
import '../../styles/compact/pages.css';
import '../../styles/compact/runs.css';

const route = getRouteApi('/projects/$projectKey/runs');

/** A finished run's stored totals in words; a run that did not complete shows its lifecycle. */
const RunResult = ({ run }: { run: RunRecord }) => {
  if (run.status !== 'completed' || run.summary === undefined)
    return <RunLifecycle status={run.status} />;

  const { passedCases, totalCases, failedCases, errorCases } = run.summary;

  return (
    <span className={failedCases + errorCases > 0 ? 'attest-hot' : undefined}>
      {passedCases} of {totalCases} passed
    </span>
  );
};

/** Every run of the project across its evals, newest first, a page at a time. */
const AllRunsPage = () => {
  const { projectKey } = route.useParams();
  const source = useDashboardSource();

  useLiveProjectOverview(source, projectKey);

  const runs = useInfiniteQuery(projectRunsQueryOptions(source, projectKey));
  const rows = runs.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <div className="attest-page-head">
        <div className="attest-page-title">
          <h1>All runs</h1>
        </div>
        <div className="attest-page-end">
          <NewRunButton projectKey={projectKey} />
        </div>
      </div>
      {runs.data === undefined ? (
        runs.error === null ? (
          <p className="attest-loading" role="status">
            Loading runs...
          </p>
        ) : (
          <EmptyState title="Could not load runs" description={runs.error.message} />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="A run records each case's output, steps and checks."
          command={source.kind === 'local' ? 'attest eval run --all' : undefined}
        />
      ) : (
        <section className="attest-card" aria-label="Runs, newest first">
          <table className="attest-table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Result</th>
                <th scope="col" className="attest-hide-narrow">
                  Branch
                </th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link
                      className="attest-rowlink attest-mono"
                      to="/projects/$projectKey/runs/$runId"
                      params={{ projectKey, runId: run.id }}
                      title={run.id}
                    >
                      {shortRunId(run.id)}
                    </Link>
                  </td>
                  <td className="attest-nw">
                    <RunResult run={run} />
                  </td>
                  <td className="attest-dim attest-hide-narrow">
                    {run.gitBranch !== undefined && <code>{run.gitBranch}</code>}
                  </td>
                  <td className="attest-nw attest-dim">{formatStarted(run.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.hasNextPage && (
            <div className="attest-card-foot">
              <button
                type="button"
                className="attest-mini-btn"
                disabled={runs.isFetchingNextPage}
                onClick={() => void runs.fetchNextPage()}
              >
                Show older runs
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
};

export { AllRunsPage };
