import { useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import { evalSlicesQueryOptions } from '../../api/queries/evals.js';
import { evalRunPagesQueryOptions, OLDER_RUN_PAGE } from '../../api/queries/runs.js';
import { TREND_LIMIT } from '../../components/charts/compact/trend-model.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { formatCount } from '../../lib/format.js';
import { useTargetHref } from '../frame/use-target-href.js';
import { EvalHead } from './eval-head.js';
import { EvalRunsTable } from './eval-runs-table.js';
import { EvalTrendPanel } from './eval-trend-panel.js';
import '../../styles/compact/pages.css';
import '../../styles/compact/runs.css';

const route = getRouteApi('/projects/$projectKey/evals/$suiteName/runs');

/**
 * One eval's Runs tab: the pass-rate trend over its runs, then the runs table, newest ten first.
 * Both read stored slice totals only; no case rows are fetched here.
 */
const EvalRunsPage = () => {
  const { projectKey, suiteName } = route.useParams();
  const { x } = route.useSearch();
  const navigate = route.useNavigate();
  const source = useDashboardSource();
  const hrefFor = useTargetHref();
  const [inspected, setInspected] = useState<string>();

  useLiveProjectOverview(source, projectKey);

  const trend = useQuery(
    evalSlicesQueryOptions(source, projectKey, suiteName, { limit: TREND_LIMIT }),
  );

  const table = useInfiniteQuery(evalRunPagesQueryOptions(source, projectKey, suiteName));
  const runs = table.data?.pages.flatMap((page) => page.items) ?? [];

  // The trend reads every run when it is not truncated, so it knows how many older rows remain.
  const older =
    trend.data !== undefined && trend.data.nextCursor === undefined
      ? Math.max(0, trend.data.items.length - runs.length)
      : undefined;

  const body = () => {
    if (table.data === undefined)
      return table.error === null ? (
        <p className="attest-loading" role="status">
          Loading runs of {suiteName}...
        </p>
      ) : (
        <EmptyState
          title="Could not load runs"
          description={table.error.message}
          action={{ label: 'Try again', onAction: () => void table.refetch() }}
        />
      );

    if (runs.length === 0)
      return (
        <EmptyState
          title="No runs yet"
          description={`A run sends each case of ${suiteName} to the agent and records its output, steps and checks.`}
          command={source.kind === 'local' ? `attest eval run ${suiteName}` : undefined}
        />
      );

    return (
      <>
        {trend.data === undefined ? (
          <p className="attest-loading" role="status">
            {trend.error?.message ?? 'Loading the pass-rate trend...'}
          </p>
        ) : (
          <EvalTrendPanel
            key={JSON.stringify([source.id, projectKey, suiteName])}
            suiteName={suiteName}
            slices={trend.data}
            axis={x}
            onAxisChange={(axis) =>
              void navigate({ search: (previous) => ({ ...previous, x: axis }), replace: true })
            }
            runHref={(slice) =>
              hrefFor({
                kind: 'run',
                sourceId: source.id,
                projectKey,
                evalId: suiteName,
                runId: slice.runId,
              })
            }
            selectedRunId={inspected}
          />
        )}
        <section className="attest-card attest-runs-card" aria-label={`Runs of ${suiteName}`}>
          <EvalRunsTable
            projectKey={projectKey}
            suiteName={suiteName}
            runs={runs}
            onInspect={setInspected}
          />
          {table.hasNextPage && (
            <div className="attest-card-foot">
              <button
                type="button"
                className="attest-mini-btn"
                disabled={table.isFetchingNextPage}
                onClick={() => void table.fetchNextPage()}
              >
                {older === undefined || older === 0
                  ? 'Show older runs'
                  : `Show ${formatCount(Math.min(older, OLDER_RUN_PAGE), 'older run')}`}
              </button>
            </div>
          )}
        </section>
      </>
    );
  };

  return (
    <>
      <EvalHead projectKey={projectKey} suiteName={suiteName} tab="runs" />
      {body()}
    </>
  );
};

export { EvalRunsPage };
