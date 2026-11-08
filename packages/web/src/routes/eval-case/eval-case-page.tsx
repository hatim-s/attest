import { useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import { caseHistoryQueryOptions } from '../../api/queries/cases.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { EXACT_STRIP_LIMIT } from '../../components/meters/case-strip.js';
import { formatCount } from '../../lib/format.js';
import { CaseHistoryStrip } from '../eval-cases/case-history-strip.js';
import { passedCount } from '../eval-cases/case-standing.js';
import { useWalkKeys } from '../run-case/use-walk-keys.js';
import { CaseOutcomes } from './case-outcomes.js';
import { useWindowNeighbours } from './use-window-neighbours.js';
import '../../styles/compact/pages.css';
import '../../styles/compact/runs.css';
import '../../styles/compact/cases.css';

const route = getRouteApi('/projects/$projectKey/evals/$suiteName/cases/$caseId');

/** Outcomes listed before "Show all". */
const NEWEST_OUTCOMES = 5;

/**
 * One case of an eval across its runs: Previous and Next in the Test cases order, the history
 * strip with how often it passed, then its outcome in each run. Case definitions are not stored
 * with runs, so the page has no Definition card.
 */
const EvalCasePage = () => {
  const { projectKey, suiteName, caseId } = route.useParams();
  const navigate = route.useNavigate();
  const source = useDashboardSource();
  // Keyed by case, so Previous and Next open the next case collapsed.
  const [expandedFor, setExpandedFor] = useState<string>();
  const expanded = expandedFor === caseId;

  useLiveProjectOverview(source, projectKey);

  const neighbours = useWindowNeighbours(source, projectKey, suiteName, caseId);
  const history = useInfiniteQuery(caseHistoryQueryOptions(source, projectKey, suiteName, caseId));
  const outcomes = history.data?.pages.flatMap((page) => page.items) ?? [];

  const open = (next: string | undefined) => {
    if (next !== undefined)
      void navigate({ params: (previous) => ({ ...previous, caseId: next }) });
  };

  useWalkKeys(
    () => open(neighbours.next),
    () => open(neighbours.previous),
  );

  const pagerLink = (target: string | undefined, label: string, keys: string) =>
    target === undefined ? (
      <span className="attest-btn-2" aria-disabled="true">
        {label}
      </span>
    ) : (
      <Link
        className="attest-btn-2"
        to="/projects/$projectKey/evals/$suiteName/cases/$caseId"
        params={{ projectKey, suiteName, caseId: target }}
        aria-keyshortcuts={keys}
        title={target}
      >
        {label}
      </Link>
    );

  const body = () => {
    if (history.data === undefined)
      return history.error === null ? (
        <p className="attest-loading" role="status">
          Loading the history of {caseId}...
        </p>
      ) : (
        <EmptyState
          title="Could not load this case's history"
          description={history.error.message}
          action={{ label: 'Try again', onAction: () => void history.refetch() }}
        />
      );

    if (outcomes.length === 0)
      return (
        <EmptyState
          title="No run has recorded this case"
          description={`${caseId} has no result in any run of ${suiteName}. Its outcomes show up here after a run records it.`}
        >
          <Link
            to="/projects/$projectKey/evals/$suiteName/cases"
            params={{ projectKey, suiteName }}
            search={{ filter: 'all' }}
          >
            See the cases of {suiteName}
          </Link>
        </EmptyState>
      );

    const { passed, recorded } = passedCount(outcomes.map((outcome) => outcome.cell));
    const runs = formatCount(recorded, 'run');
    const shown = expanded ? outcomes : outcomes.slice(0, NEWEST_OUTCOMES);

    return (
      <>
        <div className="attest-hist-sum">
          <CaseHistoryStrip
            projectKey={projectKey}
            suiteName={suiteName}
            caseId={caseId}
            marks={outcomes}
          />
          <span>
            Passed {passed} of {history.hasNextPage ? `the newest ${runs}` : runs}
            {outcomes.length > EXACT_STRIP_LIMIT &&
              `. The strip shows the newest ${EXACT_STRIP_LIMIT}`}
          </span>
        </div>
        <h2 className="attest-sec-h" id="attest-outcomes-h">
          Outcomes by run
        </h2>
        <section className="attest-card" aria-labelledby="attest-outcomes-h">
          <CaseOutcomes
            projectKey={projectKey}
            suiteName={suiteName}
            caseId={caseId}
            outcomes={shown}
          />
          {(expanded
            ? history.hasNextPage
            : outcomes.length > NEWEST_OUTCOMES || history.hasNextPage) && (
            <div className="attest-card-foot">
              <button
                type="button"
                className="attest-mini-btn"
                disabled={history.isFetchingNextPage}
                onClick={() => {
                  setExpandedFor(caseId);

                  if (history.hasNextPage) void history.fetchNextPage();
                }}
              >
                {expanded ? 'Show older runs' : 'Show all runs'}
              </button>
            </div>
          )}
        </section>
      </>
    );
  };

  return (
    <>
      <div className="attest-page-head">
        <div className="attest-page-title">
          <h1 className="attest-mono-title">{caseId}</h1>
          {neighbours.position !== undefined && (
            <p className="attest-sub attest-meta">
              <span>
                Case {neighbours.position}
                {neighbours.total !== undefined && ` of ${neighbours.total}`}
              </span>
            </p>
          )}
        </div>
        <nav className="attest-page-end attest-pager" aria-label={`Cases of ${suiteName}`}>
          {pagerLink(neighbours.previous, 'Previous', 'k')}
          {pagerLink(neighbours.next, 'Next', 'j')}
        </nav>
      </div>
      {body()}
    </>
  );
};

export { EvalCasePage };
