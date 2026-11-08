import { useId } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import { caseWindowQueryOptions } from '../../api/queries/cases.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { formatCount, shortRunId } from '../../lib/format.js';
import { EvalHead } from '../eval/eval-head.js';
import {
  CASE_FILTERS,
  caseStanding,
  matchesFilter,
  verdictRunIndex,
  type CaseFilter,
} from './case-standing.js';
import { CaseWindowTable, type CaseRow } from './case-window-table.js';
import '../../styles/compact/pages.css';
import '../../styles/compact/runs.css';
import '../../styles/compact/cases.css';

const route = getRouteApi('/projects/$projectKey/evals/$suiteName/cases');

const FILTER_LABELS = {
  all: 'All',
  failing: 'Failing',
  flaky: 'Flaky',
} as const satisfies Record<CaseFilter, string>;

/**
 * One eval's Test cases tab: every case it has recorded, with its results in the eval's newest ten
 * runs. Search and the All / Failing / Flaky chips filter the loaded pages on the client; "Load
 * more cases" follows the cursor. Case names, tags and definitions are not stored with runs, so
 * rows show case ids.
 */
const EvalCasesPage = () => {
  const { projectKey, suiteName } = route.useParams();
  const { q, filter } = route.useSearch();
  const navigate = route.useNavigate();
  const source = useDashboardSource();
  const searchId = useId();

  useLiveProjectOverview(source, projectKey);

  const cases = useInfiniteQuery(caseWindowQueryOptions(source, projectKey, suiteName));

  const setSearch = (next: { q?: string | undefined; filter?: CaseFilter }) =>
    void navigate({ search: (previous) => ({ ...previous, ...next }), replace: true });

  const body = () => {
    if (cases.data === undefined)
      return cases.error === null ? (
        <p className="attest-loading" role="status">
          Loading cases of {suiteName}...
        </p>
      ) : (
        <EmptyState
          title="Could not load the cases"
          description={cases.error.message}
          action={{ label: 'Try again', onAction: () => void cases.refetch() }}
        />
      );

    // The cursor pins the window it started with, so every page carries the same runs.
    const runs = cases.data.pages[0]?.runs ?? [];

    const all: CaseRow[] = cases.data.pages
      .flatMap((page) => page.items)
      .map((item, index) => ({
        position: index + 1,
        caseId: item.caseId,
        cells: item.cells,
        standing: caseStanding(runs, item.cells),
      }));

    if (all.length === 0)
      return (
        <EmptyState
          title="No cases yet"
          description={`A case shows up here once a run of ${suiteName} records it.`}
          command={source.kind === 'local' ? `attest eval run ${suiteName}` : undefined}
        />
      );

    const query = q?.trim().toLowerCase() ?? '';

    const rows = all.filter(
      (row) => matchesFilter(row.standing, filter) && row.caseId.toLowerCase().includes(query),
    );

    const verdictRun = runs[verdictRunIndex(runs)];

    const counts = {
      all: all.length,
      failing: all.filter((row) => row.standing.failing).length,
      flaky: all.filter((row) => row.standing.flaky).length,
    } satisfies Record<CaseFilter, number>;

    const titles = {
      all: undefined,
      failing:
        verdictRun === undefined
          ? undefined
          : `Failed or errored in run ${shortRunId(verdictRun.runId)}, the newest completed run`,
      flaky: `Passed and failed across these ${formatCount(runs.length, 'run')}`,
    } satisfies Record<CaseFilter, string | undefined>;

    // Failing needs a completed run to read verdicts from; without one the chip is left out.
    const chips = CASE_FILTERS.filter((key) => key !== 'failing' || verdictRun !== undefined);

    const removals = [
      ...(query === ''
        ? []
        : [{ label: `"${q?.trim()}"`, remove: () => setSearch({ q: undefined }) }]),
      ...(filter === 'all'
        ? []
        : [{ label: FILTER_LABELS[filter], remove: () => setSearch({ filter: 'all' }) }]),
    ];

    return (
      <>
        <div className="attest-toolbar">
          <label className="attest-sr-only" htmlFor={searchId}>
            Search cases by id
          </label>
          <input
            id={searchId}
            className="attest-search"
            type="search"
            placeholder="Search case ids"
            autoComplete="off"
            value={q ?? ''}
            onChange={(event) =>
              setSearch({ q: event.target.value === '' ? undefined : event.target.value })
            }
          />
          {runs.length > 0 && (
            <div className="attest-chips" role="group" aria-label="Show cases">
              {chips.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  title={titles[key]}
                  data-hot={key === 'failing' && counts.failing > 0 ? 'true' : undefined}
                  onClick={() => setSearch({ filter: key })}
                >
                  {FILTER_LABELS[key]}
                  <span>{counts[key]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <section className="attest-card" aria-label={`Test cases in ${suiteName}`}>
          <CaseWindowTable
            projectKey={projectKey}
            suiteName={suiteName}
            runs={runs}
            rows={rows}
            empty={
              <div className="attest-nores" role="status">
                <span>No cases match</span>
                {removals.map((removal) => (
                  <button
                    key={removal.label}
                    type="button"
                    className="attest-chip-x"
                    aria-label={`Remove ${removal.label}`}
                    onClick={removal.remove}
                  >
                    {removal.label}
                    <span aria-hidden="true">&times;</span>
                  </button>
                ))}
                {removals.length > 1 && (
                  <button
                    type="button"
                    className="attest-link-btn"
                    onClick={() => setSearch({ q: undefined, filter: 'all' })}
                  >
                    Clear all
                  </button>
                )}
              </div>
            }
          />
          {cases.hasNextPage && (
            <div className="attest-card-foot attest-foot-row">
              <button
                type="button"
                className="attest-mini-btn"
                disabled={cases.isFetchingNextPage}
                onClick={() => void cases.fetchNextPage()}
              >
                Load more cases
              </button>
              <span className="attest-dim">
                Counts and filters cover the first {formatCount(all.length, 'case')}.
              </span>
            </div>
          )}
        </section>
      </>
    );
  };

  return (
    <>
      <EvalHead projectKey={projectKey} suiteName={suiteName} tab="cases" />
      {body()}
    </>
  );
};

export { EvalCasesPage };
