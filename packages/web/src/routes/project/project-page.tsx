import { getRouteApi } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { EvalSummary } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import { evalsQueryOptions } from '../../api/queries/evals.js';
import { overviewsQueryOptions } from '../../api/queries/projects.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { formatCount } from '../../lib/format.js';
import { NewRunButton } from '../new-run/new-run-button.js';
import { ActivityPanel } from './activity-panel.js';
import { EvalsTable } from './evals-table.js';
import { PassRatePanel } from './pass-rate-panel.js';
import {
  PROJECT_RANGES,
  RANGE_NAMES,
  projectWindow,
  rangeLabel,
  utcToday,
} from './project-range.js';
import '../../styles/compact/pages.css';

const route = getRouteApi('/projects/$projectKey/');

/** The chart shows the eval in the URL, else the first eval that ran in the period, else the first. */
const chartedEval = (evals: readonly EvalSummary[], requested: string | undefined, since: string) =>
  evals.find((evaluation) => evaluation.suiteName === requested)?.suiteName ??
  evals.find((evaluation) => Date.parse(evaluation.latest.createdAt) >= Date.parse(since))
    ?.suiteName ??
  evals[0]?.suiteName;

/**
 * One project: how it is trending over the chosen period, then its evals. Every read here is a
 * precomputed summary; no case rows are fetched.
 */
const ProjectPage = () => {
  const { projectKey } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const source = useDashboardSource();
  const overview = useLiveProjectOverview(source, projectKey);
  const running = (overview.data?.runningRunCount ?? 0) > 0;
  const evals = useQuery(evalsQueryOptions(source, projectKey, running));

  const project = useQuery(overviewsQueryOptions(source)).data?.items.find(
    (entry) => entry.project.key === projectKey,
  )?.project;

  const window = projectWindow(search.range, utcToday());
  const rangeName = RANGE_NAMES[search.range];
  const items = evals.data?.items ?? [];

  return (
    <>
      <div className="attest-page-head">
        <div className="attest-page-title">
          <h1>{project?.name ?? projectKey}</h1>
          {(project?.root !== undefined || running) && (
            <p className="attest-sub">
              {project?.root !== undefined && <code>{project.root}</code>}
              {project?.root !== undefined && running && ' '}
              {running &&
                overview.data !== undefined &&
                `${formatCount(overview.data.runningRunCount, 'run')}${overview.data.runningRunCountTruncated ? '+' : ''} in progress`}
            </p>
          )}
        </div>
        <div className="attest-page-end">
          {items.length > 0 && (
            <>
              <span className="attest-dim">{rangeLabel(window)}</span>
              <div className="attest-seg" role="group" aria-label="Period">
                {PROJECT_RANGES.map((range) => (
                  <button
                    type="button"
                    key={range}
                    aria-pressed={search.range === range}
                    onClick={() =>
                      void navigate({ search: (previous) => ({ ...previous, range }) })
                    }
                  >
                    {RANGE_NAMES[range]}
                  </button>
                ))}
              </div>
            </>
          )}
          <NewRunButton projectKey={projectKey} />
        </div>
      </div>
      <div className="attest-pcharts">
        <PassRatePanel
          source={source}
          projectKey={projectKey}
          evals={items}
          selected={chartedEval(items, search.eval, window.from)}
          onSelect={(suiteName) =>
            void navigate({
              search: (previous) => ({ ...previous, eval: suiteName }),
              replace: true,
            })
          }
          since={window.from}
          rangeName={rangeName}
        />
        <ActivityPanel
          source={source}
          projectKey={projectKey}
          window={window}
          rangeName={rangeName}
          hasEvals={items.length > 0}
        />
      </div>
      <h2 className="attest-sec-h">Evals</h2>
      {evals.data === undefined ? (
        evals.error === null ? (
          <p className="attest-loading" role="status">
            Loading evals...
          </p>
        ) : (
          <EmptyState
            title="Could not load evals"
            description={evals.error.message}
            action={{ label: 'Try again', onAction: () => void evals.refetch() }}
          />
        )
      ) : items.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="An eval shows up here once a run records its results."
          command={source.kind === 'local' ? 'attest eval run' : undefined}
        />
      ) : (
        <EvalsTable projectKey={projectKey} evals={evals.data} />
      )}
    </>
  );
};

export { ProjectPage };
