import type { RunDiff, RunRecord } from '../api/types.js';
import { formatPercent, shortId } from '../lib/format.js';
import { Badge, Card, ErrorNotice, Loading } from './ui.js';

type DiffPanelProps = {
  baseRunId?: string;
  candidateRunId: string;
  diff?: RunDiff;
  error: unknown;
  isLoading: boolean;
  onBaseChange: (runId: string) => void;
  runs: RunRecord[];
};

const transitionTone = (kind: string): string => {
  if (kind === 'regressed' || kind === 'still_failing') return 'fail';
  if (kind === 'fixed' || kind === 'still_passing') return 'pass';
  return 'neutral';
};

/** Renders deterministic run comparisons with headline deltas and case-level evidence. */
const DiffPanel = ({
  baseRunId,
  candidateRunId,
  diff,
  error,
  isLoading,
  onBaseChange,
  runs,
}: DiffPanelProps) => (
  <div className="diff-panel">
    <div className="compare-picker">
      <label htmlFor="baseline">Baseline run</label>
      <select
        id="baseline"
        onChange={(event) => onBaseChange(event.target.value)}
        value={baseRunId ?? ''}
      >
        <option disabled value="">
          Select a baseline
        </option>
        {runs
          .filter((run) => run.id !== candidateRunId)
          .map((run) => (
            <option key={run.id} value={run.id}>
              {shortId(run.id)} · {run.status}
            </option>
          ))}
      </select>
      <span className="compare-arrow">→</span>
      <div className="candidate-label">
        <span>Candidate</span>
        <strong>{shortId(candidateRunId)}</strong>
      </div>
    </div>
    {isLoading ? <Loading label="Computing diff" /> : null}
    {error !== null && error !== undefined ? <ErrorNotice error={error} /> : null}
    {diff !== undefined ? (
      <>
        <div className="summary-grid diff-summary-grid">
          <Card className="summary-card">
            <span className="summary-label">Baseline</span>
            <strong>{formatPercent(diff.summary.basePassRate)}</strong>
          </Card>
          <Card className="summary-card">
            <span className="summary-label">Candidate</span>
            <strong>{formatPercent(diff.summary.candidatePassRate)}</strong>
          </Card>
          <Card className="summary-card">
            <span className="summary-label">Regressions</span>
            <strong>{diff.summary.counts.regressed}</strong>
          </Card>
          <Card className="summary-card">
            <span className="summary-label">Fixed</span>
            <strong>{diff.summary.counts.fixed}</strong>
          </Card>
        </div>
        <div className="transition-list">
          {diff.transitions.map((transition) => (
            <div className="transition-row" key={`${transition.suiteName}:${transition.caseId}`}>
              <div>
                <strong>{transition.caseId}</strong>
                <span>{transition.suiteName}</span>
              </div>
              <Badge tone={transitionTone(transition.kind)}>
                {transition.kind.replace('_', ' ')}
              </Badge>
              <span className="metric-delta">{transition.metricDeltas.length} metric changes</span>
            </div>
          ))}
          {diff.transitions.length === 0 ? (
            <div className="empty-compact">These runs contain no comparable cases.</div>
          ) : null}
        </div>
      </>
    ) : null}
  </div>
);

export { DiffPanel, type DiffPanelProps };
