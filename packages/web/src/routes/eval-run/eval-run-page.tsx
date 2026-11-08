import { getRouteApi, Link } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { RunRecord } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import { evalSlicesQueryOptions } from '../../api/queries/evals.js';
import {
  caseSummariesQueryOptions,
  runQueryOptions,
  runSuitesQueryOptions,
} from '../../api/queries/runs.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { RunLifecycle } from '../../components/marks/run-lifecycle.js';
import {
  formatCount,
  formatDuration,
  formatStarted,
  shortRunId,
  shortSha,
} from '../../lib/format.js';
import { CancelRun } from './cancel-run.js';
import { CompareRuns } from './compare-runs.js';
import { FailedCases } from './failed-cases.js';
import { RunCaseList } from './run-case-list.js';
import { RunSummary } from './run-summary.js';
import '../../styles/compact/pages.css';
import '../../styles/compact/runs.css';

const route = getRouteApi('/projects/$projectKey/evals/$suiteName/runs/$runId');

/** Earlier slices read for the change line and the comparison choices. */
const EARLIER_LIMIT = 100;

/** Start, duration and branch; the commit sits in the branch's tooltip. */
const RunMeta = ({ run }: { run: RunRecord }) => {
  const took =
    run.status === 'running'
      ? `running for ${formatDuration(Date.now() - Date.parse(run.createdAt))}`
      : `took ${formatDuration(Date.parse(run.finishedAt) - Date.parse(run.createdAt))}`;

  const branch = run.gitBranch ?? (run.gitSha === undefined ? undefined : shortSha(run.gitSha));

  return (
    <p className="attest-sub attest-meta">
      <span>
        {formatStarted(run.createdAt)}, {took}
      </span>
      {branch !== undefined && (
        <span title={run.gitSha === undefined ? undefined : `Commit ${run.gitSha}`}>
          <code>{branch}</code>
        </span>
      )}
    </p>
  );
};

/**
 * One run of one eval: what failed and why, a comparison on request, then every case. The run's
 * own reads poll every 2 s while it executes; nothing here reads full case records up front.
 */
const EvalRunPage = () => {
  const { projectKey, suiteName, runId } = route.useParams();
  const source = useDashboardSource();

  useLiveProjectOverview(source, projectKey);

  const run = useQuery(runQueryOptions(source, projectKey, runId));
  const running = run.data?.status === 'running';
  const suites = useQuery(runSuitesQueryOptions(source, projectKey, runId, running));

  const cases = useInfiniteQuery(
    caseSummariesQueryOptions(source, projectKey, { runId, suiteName }, running),
  );

  const earlier = useQuery({
    ...evalSlicesQueryOptions(source, projectKey, suiteName, {
      until: run.data?.createdAt,
      limit: EARLIER_LIMIT,
    }),
    enabled: run.data !== undefined,
  });

  if (run.data === undefined)
    return run.error === null ? (
      <p className="attest-loading" role="status">
        Loading run {shortRunId(runId)}...
      </p>
    ) : (
      <EmptyState title="Could not load this run" description={run.error.message} />
    );

  const slice = suites.data?.suites.find((item) => item.suiteName === suiteName);
  const rows = cases.data?.pages.flatMap((page) => page.items) ?? [];
  const failed = rows.filter((summary) => summary.verdict !== 'pass');
  const positions = new Map(rows.map((summary, index) => [summary.caseId, index + 1]));

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
          <RunMeta run={run.data} />
        </div>
        <div className="attest-page-end">
          <CancelRun
            projectKey={projectKey}
            run={run.data}
            evalCount={suites.data?.suites.length ?? 1}
          />
        </div>
      </div>
      {suites.error !== null && suites.data === undefined && (
        <EmptyState title="Could not load this run's results" description={suites.error.message} />
      )}
      {suites.data !== undefined && slice === undefined && (
        <EmptyState
          title={`No results for ${suiteName}`}
          description={
            running
              ? `Run ${shortRunId(runId)} has not recorded a case of ${suiteName} yet.`
              : `Run ${shortRunId(runId)} did not run ${suiteName}.`
          }
        >
          <Link to="/projects/$projectKey/runs/$runId" params={{ projectKey, runId }}>
            See the evals in this run
          </Link>
        </EmptyState>
      )}
      {slice !== undefined && (
        <>
          <RunSummary projectKey={projectKey} slice={slice} earlier={earlier.data} cases={rows} />
          {failed.length > 0 && (
            <section aria-labelledby="attest-failed-h">
              <h2 className="attest-sec-h" id="attest-failed-h">
                {running ? 'Failed so far' : 'Failed'}{' '}
                <span className="attest-dim">{failed.length}</span>
              </h2>
              <FailedCases
                projectKey={projectKey}
                runId={runId}
                failed={failed}
                positions={positions}
              />
            </section>
          )}
          <CompareRuns
            projectKey={projectKey}
            suiteName={suiteName}
            runId={runId}
            earlier={earlier.data?.items.filter((item) => item.state !== 'running') ?? []}
          />
          <section aria-labelledby="attest-cases-h">
            <h2 className="attest-sec-h" id="attest-cases-h">
              All cases <span className="attest-dim">{rows.length}</span>
            </h2>
            {cases.error !== null && rows.length === 0 ? (
              <EmptyState title="Could not load the cases" description={cases.error.message} />
            ) : rows.length === 0 ? (
              <p className="attest-dim">
                {cases.isPending ? 'Loading cases...' : 'No case of this eval has a result yet.'}
              </p>
            ) : (
              <RunCaseList projectKey={projectKey} runId={runId} cases={rows} />
            )}
            {cases.hasNextPage && (
              <button
                type="button"
                className="attest-mini-btn attest-more"
                disabled={cases.isFetchingNextPage}
                onClick={() => void cases.fetchNextPage()}
              >
                Show more cases
              </button>
            )}
            {cases.hasNextPage && failed.length > 0 && (
              <p className="attest-dim">
                The failed list covers the first {formatCount(rows.length, 'case')}.
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
};

export { EvalRunPage };
