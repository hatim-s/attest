import { useEffect, useMemo, useState } from 'react';

import { useCase, useCases, useDiff, useRun, useRuns } from './api/queries.js';
import type { CaseSummary } from './api/types.js';
import { CaseDetail } from './components/cases/case-detail.js';
import { CaseTable } from './components/cases/case-table.js';
import { DiffPanel } from './components/cases/diff-panel.js';
import { DistributionCharts } from './components/runs/distribution-charts.js';
import { RunList } from './components/runs/run-list.js';
import { SummaryCards } from './components/runs/summary-cards.js';
import { Badge, Button, Card, ErrorNotice, Loading } from './components/shared/ui.js';
import { shortId } from './lib/format.js';
import { getReportData } from './report/report-data.js';

type DashboardTab = 'cases' | 'compare' | 'distributions';
type Theme = 'light' | 'dark';

const getInitialTheme = (): Theme => {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('attest-theme');
  } catch {
    // Some browsers disable local storage for file:// reports; system preference remains safe.
  }
  if (stored === 'light' || stored === 'dark') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/** Coordinates dashboard selection state while queries retain ownership of server data. */
const Dashboard = () => {
  const reportData = getReportData();
  const runsQuery = useRuns();
  const runs = runsQuery.data ?? [];
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedCase, setSelectedCase] = useState<CaseSummary>();
  const [baseRunId, setBaseRunId] = useState<string>();
  const [tab, setTab] = useState<DashboardTab>('cases');
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const runQuery = useRun(selectedRunId);
  const casesQuery = useCases(selectedRunId, runQuery.data?.status);
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
    try {
      localStorage.setItem('attest-theme', theme);
    } catch {
      // Theme still applies for this session when file:// storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    setBaseRunId((current) =>
      current === selectedRunId ? runs.find((run) => run.id !== selectedRunId)?.id : current,
    );
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (
      tab === 'distributions' &&
      casesQuery.hasNextPage === true &&
      !casesQuery.isFetching &&
      !casesQuery.isFetchNextPageError
    ) {
      void casesQuery.fetchNextPage();
    }
  }, [casesQuery, tab]);

  /** Resets case evidence only when the user switches to a different run. */
  const selectRun = (runId: string) => {
    if (runId !== selectedRunId) setSelectedCase(undefined);
    setSelectedRunId(runId);
  };

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
          <Badge tone="local">{reportData === undefined ? '127.0.0.1' : 'static report'}</Badge>
          <Button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} tone="ghost">
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </header>
      <div className="workspace">
        <RunList
          error={runsQuery.error}
          isLoading={runsQuery.isLoading}
          onSelect={selectRun}
          runs={runs}
          selectedRunId={selectedRunId}
        />
        <main className="main-content">
          {selectedRunId === undefined && runsQuery.isSuccess && runs.length === 0 ? (
            <Card className="welcome-card">
              <p className="eyebrow">Ready</p>
              <h1>Run your first evaluation</h1>
              <p>
                Use <code>attest eval run</code>, then this view will update automatically.
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
                    {run.configHash.slice(0, 12)} · {run.schemaId}
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
                  Cases <span>{run.summary?.totalCases ?? cases.length}</span>
                </Button>
                <Button
                  aria-selected={tab === 'distributions'}
                  onClick={() => setTab('distributions')}
                  role="tab"
                  tone={tab === 'distributions' ? 'primary' : 'ghost'}
                >
                  Distributions
                </Button>
                {runs.length > 1 ? (
                  <Button
                    aria-selected={tab === 'compare'}
                    onClick={() => setTab('compare')}
                    role="tab"
                    tone={tab === 'compare' ? 'primary' : 'ghost'}
                  >
                    Compare
                  </Button>
                ) : null}
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
                  {casesQuery.isSuccess && cases.length === 0 ? (
                    <div className="empty-compact">
                      {run.status === 'running'
                        ? 'Waiting for the first case. Results update automatically.'
                        : 'This run has no recorded cases.'}
                    </div>
                  ) : null}
                </section>
              ) : null}
              {tab === 'distributions' ? (
                <>
                  {casesQuery.error !== null ? <ErrorNotice error={casesQuery.error} /> : null}
                  <DistributionCharts
                    cases={cases}
                    isLoading={casesQuery.isFetching}
                    theme={theme}
                    totalCases={run.summary?.totalCases ?? cases.length}
                  />
                </>
              ) : null}
              {tab === 'compare' ? (
                <DiffPanel
                  baseRunId={baseRunId}
                  candidateRunId={run.id}
                  diff={diffQuery.data}
                  error={diffQuery.error}
                  isLoading={diffQuery.isLoading}
                  onBaseChange={setBaseRunId}
                  runs={runs}
                />
              ) : null}
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
