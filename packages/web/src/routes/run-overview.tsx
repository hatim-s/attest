import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { useApiClient } from '../api/api-client-context.js';
import { useRuns } from '../api/queries.js';
import { SummaryCards } from '../components/runs/summary-cards.js';
import { Badge } from '../components/shared/ui.js';
import { shortId } from '../lib/format.js';

/** Keeps the run context visible when switching to a comparison URL. */
const RunOverview = ({
  run,
  tab,
}: {
  run: RunRecord;
  tab: 'cases' | 'distributions' | 'suites' | 'compare';
}) => {
  const { mode } = useApiClient();
  const runsQuery = useRuns();
  const baseRun = runsQuery.data?.find((item) => item.id !== run.id);

  return (
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
      {mode.kind === 'snapshot' ? (
        <section className="empty-compact" aria-label="Report contents">
          {mode.includedCases}{' '}
          {run.summary === undefined
            ? 'cases included; total unavailable.'
            : `of ${run.summary.totalCases} cases included.`}
          {mode.truncated
            ? ' This report is truncated. Omitted cases and traces are unavailable; distributions cover only included cases.'
            : ''}
        </section>
      ) : null}
      <div className="tabs" role="tablist">
        {(['cases', 'distributions', 'suites'] as const).map((id) => (
          <Link
            key={id}
            to="/runs/$runId"
            params={{ runId: run.id }}
            search={(previous) => ({ ...previous, tab: id })}
            role="tab"
            aria-selected={tab === id}
            className={`button button-${tab === id ? 'primary' : 'ghost'}`}
          >
            {id === 'cases' ? (
              <>
                Cases<span>{run.summary?.totalCases ?? 0}</span>
              </>
            ) : id === 'suites' ? (
              'Suites'
            ) : (
              'Distributions'
            )}
          </Link>
        ))}
        {baseRun !== undefined ? (
          <Link
            to="/compare/$baseRunId/$candidateRunId"
            params={{ baseRunId: baseRun.id, candidateRunId: run.id }}
            role="tab"
            aria-selected={tab === 'compare'}
            className={`button button-${tab === 'compare' ? 'primary' : 'ghost'}`}
          >
            Compare
          </Link>
        ) : null}
      </div>
    </>
  );
};

export { RunOverview };
