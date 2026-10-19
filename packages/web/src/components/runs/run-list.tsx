import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { formatDateTime, formatPassRate, shortId } from '../../lib/format.js';
import { Badge, ErrorNotice, Loading } from '../shared/ui.js';

type RunListProps = {
  error: unknown;
  isLoading: boolean;
  projectKey: string;
  runs: RunRecord[];
  selectedRunId?: string;
};

/** Sidebar of recent runs. The selected run carries `aria-current="page"`. */
const RunList = ({ error, isLoading, projectKey, runs, selectedRunId }: RunListProps) => (
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
      <div className="empty-compact">
        No evaluations yet. Run <code>attest eval run</code> to create one.
      </div>
    ) : null}
    <div className="run-list">
      {runs.map((run) => (
        <Link
          aria-current={selectedRunId === run.id ? 'page' : undefined}
          className="run-list-item"
          key={run.id}
          to="/projects/$projectKey/runs/$runId"
          params={{ projectKey, runId: run.id }}
          search={({ branch, label }) => ({ branch, label, tab: 'cases' })}
        >
          <span className="run-list-row">
            <span className="run-id">{shortId(run.id)}</span>
            <Badge tone={run.status}>{run.status}</Badge>
          </span>
          <span className="run-list-row run-list-meta">
            <span>{formatDateTime(run.createdAt)}</span>
            <span>{formatPassRate(run)}</span>
          </span>
        </Link>
      ))}
    </div>
  </aside>
);

export { RunList, type RunListProps };
