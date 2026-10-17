import type { RunRecord } from '@attest/core/records';
import { useApiClient } from '../../api/api-client-context.js';
import { SummaryCards } from './summary-cards.js';
import { Badge } from '../shared/ui.js';
import { shortId } from '../../lib/format.js';

/** Keeps the run context visible on every run tab and on the comparison page. */
const RunHeader = ({ run }: { run: RunRecord }) => {
  const { mode } = useApiClient();

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
    </>
  );
};

export { RunHeader };
