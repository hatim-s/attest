import { useEffect, useMemo, useState } from 'react';

import { useCase, useCases, useDiff, useRun, useRuns } from './api/queries.js';
import type { CaseSummary } from './api/types.js';
import { CaseDetail } from './components/case-detail.js';
import { CaseTable } from './components/case-table.js';
import { DiffPanel } from './components/diff-panel.js';
import { RunList } from './components/run-list.js';
import { SummaryCards } from './components/summary-cards.js';
import { Badge, Button, Card, ErrorNotice, Loading } from './components/ui.js';
import { shortId } from './lib/format.js';

type DashboardTab = 'cases' | 'compare';
type Theme = 'light' | 'dark';

const getInitialTheme = (): Theme => {
  const stored = localStorage.getItem('attest-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/** Coordinates dashboard selection state while queries retain ownership of server data. */
const Dashboard = () => {
  const runsQuery = useRuns();
  const runs = runsQuery.data ?? [];
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedCase, setSelectedCase] = useState<CaseSummary>();
  const [baseRunId, setBaseRunId] = useState<string>();
  const [tab, setTab] = useState<DashboardTab>('cases');
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const runQuery = useRun(selectedRunId);
  const casesQuery = useCases(selectedRunId);
  const caseQuery = useCase(selectedRunId, selectedCase?.suiteName, selectedCase?.caseId);
  const diffQuery = useDiff(baseRunId, selectedRunId);
  const cases = useMemo(
    () => casesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [casesQuery.data],
  );

  useEffect(() => {
    if (selectedRunId === undefined && runs[0] !== undefined) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('attest-theme', theme);
  }, [theme]);

  useEffect(() => {
    setSelectedCase(undefined);
    setBaseRunId((current) =>
      current === selectedRunId ? runs.find((run) => run.id !== selectedRunId)?.id : current,
    );
  }, [runs, selectedRunId]);

  const run = runQuery.data;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>attest</strong>
            <span>local evaluations</span>
          </div>
        </div>
        <div className="topbar-actions">
          <Badge tone="local">127.0.0.1</Badge>
          <Button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} tone="ghost">
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </header>
      <div className="workspace">
        <RunList
          error={runsQuery.error}
          isLoading={runsQuery.isLoading}
          onSelect={setSelectedRunId}
          runs={runs}
          selectedRunId={selectedRunId}
        />
        <main className="main-content">
          {selectedRunId === undefined ? (
            <Card className="welcome-card">
              <p className="eyebrow">Ready</p>
              <h1>Run your first evaluation</h1>
              <p>
                Use <code>attest run</code>, then this view will update automatically.
              </p>
            </Card>
          ) : null}
          {runQuery.isLoading ? <Loading label="Loading run" /> : null}
          {runQuery.error !== null ? <ErrorNotice error={runQuery.error} /> : null}
          {run !== undefined ? (
            <>
              <section className="run-heading">
                <div>
                  <p className="eyebrow">Evaluation run</p>
                  <h1>{shortId(run.id, 12)}</h1>
                  <p>
                    {run.configHash.slice(0, 12)} · config v{run.configVersion}
                  </p>
                </div>
                <Badge tone={run.status}>{run.status}</Badge>
              </section>
              <SummaryCards run={run} />
              <div className="tabs" role="tablist">
                <Button
                  aria-selected={tab === 'cases'}
                  onClick={() => setTab('cases')}
                  role="tab"
                  tone={tab === 'cases' ? 'primary' : 'ghost'}
                >
                  Cases <span>{run.summary?.totalCases ?? 0}</span>
                </Button>
                <Button
                  aria-selected={tab === 'compare'}
                  onClick={() => setTab('compare')}
                  role="tab"
                  tone={tab === 'compare' ? 'primary' : 'ghost'}
                >
                  Compare
                </Button>
              </div>
              {tab === 'cases' ? (
                <section aria-label="Cases">
                  {casesQuery.isLoading ? <Loading label="Loading cases" /> : null}
                  {casesQuery.error !== null ? <ErrorNotice error={casesQuery.error} /> : null}
                  {cases.length > 0 ? (
                    <CaseTable
                      cases={cases}
                      hasNextPage={casesQuery.hasNextPage}
                      isFetchingNextPage={casesQuery.isFetchingNextPage}
                      onLoadMore={() => void casesQuery.fetchNextPage()}
                      onSelect={setSelectedCase}
                    />
                  ) : null}
                  {!casesQuery.isLoading && cases.length === 0 ? (
                    <div className="empty-compact">This run has no recorded cases.</div>
                  ) : null}
                </section>
              ) : (
                <DiffPanel
                  baseRunId={baseRunId}
                  candidateRunId={run.id}
                  diff={diffQuery.data}
                  error={diffQuery.error}
                  isLoading={diffQuery.isLoading}
                  onBaseChange={setBaseRunId}
                  runs={runs}
                />
              )}
            </>
          ) : null}
        </main>
      </div>
      {selectedCase !== undefined ? (
        <CaseDetail
          caseRecord={caseQuery.data}
          error={caseQuery.error}
          isLoading={caseQuery.isLoading}
          onClose={() => setSelectedCase(undefined)}
          selected={selectedCase}
        />
      ) : null}
    </div>
  );
};

export { Dashboard };
