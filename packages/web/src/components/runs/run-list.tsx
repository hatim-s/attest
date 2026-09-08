import type { RunRecord } from '../../api/types.js';
import { formatDateTime, formatPercent, shortId } from '../../lib/format.js';
import { Badge, Button, ErrorNotice, Loading } from '../shared/ui.js';

type RunListProps = {
  error: unknown;
  isLoading: boolean;
  onSelect: (runId: string) => void;
  runs: RunRecord[];
  selectedRunId?: string;
};

const passRate = (run: RunRecord): number | undefined => {
  if (run.summary === undefined || run.summary.totalCases === 0) return undefined;
  return run.summary.passedCases / run.summary.totalCases;
};

/** Renders recent evaluations as a keyboard-operable local run navigator. */
const RunList = ({ error, isLoading, onSelect, runs, selectedRunId }: RunListProps) => (
  <aside className="run-sidebar" aria-label="Evaluation runs">
    <div className="run-sidebar-heading">
      <div>
        <p className="eyebrow">Workspace</p>
        <h2>Recent runs</h2>
      </div>
      <Badge>{runs.length}</Badge>
    </div>
    {isLoading ? <Loading label="Loading runs" /> : null}
    {error !== null && error !== undefined ? <ErrorNotice error={error} /> : null}
    {!isLoading && error == null && runs.length === 0 ? (
      <div className="empty-compact">No evaluations yet. Run `attest eval run` to create one.</div>
    ) : null}
    <div className="run-list">
      {runs.map((run) => (
        <Button
          aria-current={selectedRunId === run.id ? 'page' : undefined}
          className="run-list-item"
          key={run.id}
          onClick={() => onSelect(run.id)}
          tone="ghost"
        >
          <span className="run-list-row">
            <span className="run-id">{shortId(run.id)}</span>
            <Badge tone={run.status}>{run.status}</Badge>
          </span>
          <span className="run-list-row run-list-meta">
            <span>{formatDateTime(run.createdAt)}</span>
            <span>{formatPercent(passRate(run))}</span>
          </span>
        </Button>
      ))}
    </div>
  </aside>
);

export { RunList, type RunListProps };
