import type { RunRecord } from '@attest/core/records';
import { useApiClient } from '../../api/api-client-context.js';
import { SummaryCards } from './summary-cards.js';
import { Badge } from '../shared/ui.js';
import { formatCount, shortId } from '../../lib/format.js';

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
        <p className="empty-compact">
          This report includes{' '}
          {run.summary === undefined
            ? formatCount(mode.includedCases, 'case')
            : `${mode.includedCases} of ${formatCount(run.summary.totalCases, 'case')}`}
          .{mode.truncated ? ' Charts and tables cover only those.' : ''}
        </p>
      ) : null}
    </>
  );
};

export { RunHeader };
