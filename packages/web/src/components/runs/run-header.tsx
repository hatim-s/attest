import type { ReactNode } from 'react';
import type { RunRecord } from '@attest/core/records';
import { useApiClient } from '../../api/api-client-context.js';
import { SummaryCards } from './summary-cards.js';
import { Badge, Heading } from '../shared/ui.js';
import { formatCount, shortId } from '../../lib/format.js';

type RunHeaderProps = {
  run: RunRecord;
  /** Controls beside the status badge, such as cancelling a running run. */
  children?: ReactNode;
};

/** Keeps the run context visible on every run tab and on the comparison page. */
const RunHeader = ({ run, children }: RunHeaderProps) => {
  const { mode } = useApiClient();

  return (
    <>
      <Heading
        level={1}
        eyebrow="Evaluation run"
        title={<code title={run.id}>{shortId(run.id, 12)}</code>}
        meta={`${run.configHash.slice(0, 12)} · ${run.schemaId}`}
      >
        <div className="run-header-status">
          <Badge tone={run.status}>{run.status}</Badge>
          {children}
        </div>
      </Heading>
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
