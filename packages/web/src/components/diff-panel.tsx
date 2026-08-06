import { useState } from 'react';

import type { CaseTransition, CaseVerdict, RunDiff, RunRecord } from '../api/types.js';
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

type VerdictMatrix = Record<CaseVerdict, Record<CaseVerdict, number>>;

const verdicts: CaseVerdict[] = ['pass', 'fail', 'error'];

/** Counts comparable cases into the complete baseline-to-candidate verdict matrix. */
const createVerdictMatrix = (transitions: CaseTransition[]): VerdictMatrix => {
  const matrix: VerdictMatrix = {
    pass: { pass: 0, fail: 0, error: 0 },
    fail: { pass: 0, fail: 0, error: 0 },
    error: { pass: 0, fail: 0, error: 0 },
  };
  for (const transition of transitions) {
    if (transition.baseVerdict !== undefined && transition.candidateVerdict !== undefined) {
      matrix[transition.baseVerdict][transition.candidateVerdict] += 1;
    }
  }
  return matrix;
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
}: DiffPanelProps) => {
  const [selectedTransition, setSelectedTransition] = useState<string>();
  const matrix = createVerdictMatrix(diff?.transitions ?? []);

  return (
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
          <section className="verdict-matrix-card" aria-label="Verdict transition matrix">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Verdict transitions</p>
                <h3>Baseline → candidate</h3>
              </div>
              <span>{diff.summary.flakySuspectCount} flaky suspects</span>
            </div>
            <div className="verdict-matrix">
              <span />
              {verdicts.map((verdict) => (
                <strong key={`candidate-${verdict}`}>{verdict}</strong>
              ))}
              {verdicts.flatMap((baseVerdict) => [
                <strong key={`base-${baseVerdict}`}>{baseVerdict}</strong>,
                ...verdicts.map((candidateVerdict) => (
                  <div
                    className={`matrix-cell matrix-${baseVerdict}-${candidateVerdict}`}
                    key={`${baseVerdict}-${candidateVerdict}`}
                  >
                    {matrix[baseVerdict][candidateVerdict]}
                  </div>
                )),
              ])}
            </div>
          </section>
          <div className="transition-list">
            {diff.transitions.map((transition) => {
              const key = `${transition.suiteName}:${transition.caseId}`;
              const expanded = selectedTransition === key;
              return (
                <div className="transition-item" key={key}>
                  <button
                    aria-expanded={expanded}
                    className="transition-row"
                    onClick={() => setSelectedTransition(expanded ? undefined : key)}
                    type="button"
                  >
                    <div>
                      <strong>{transition.caseId}</strong>
                      <span>{transition.suiteName}</span>
                    </div>
                    <Badge tone={transitionTone(transition.kind)}>
                      {transition.kind.replace('_', ' ')}
                    </Badge>
                    <span className="metric-delta">
                      {transition.metricDeltas.length} metric changes ·{' '}
                      {expanded ? 'hide' : 'inspect'}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="transition-detail">
                      <div className="verdict-path">
                        <Badge tone={transition.baseVerdict ?? 'neutral'}>
                          {transition.baseVerdict ?? 'missing'}
                        </Badge>
                        <span>→</span>
                        <Badge tone={transition.candidateVerdict ?? 'neutral'}>
                          {transition.candidateVerdict ?? 'missing'}
                        </Badge>
                      </div>
                      {transition.metricDeltas.length === 0 ? (
                        <p>No metric-level score or pass changes.</p>
                      ) : (
                        <div className="metric-delta-list">
                          {transition.metricDeltas.map((metric) => (
                            <div className="metric-delta-row" key={metric.metricName}>
                              <strong>{metric.metricName}</strong>
                              <span>{metric.baseScore ?? '—'}</span>
                              <span>→</span>
                              <span>{metric.candidateScore ?? '—'}</span>
                              <Badge tone={metric.passTransition === 'lost' ? 'fail' : 'neutral'}>
                                {metric.passTransition}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {diff.transitions.length === 0 ? (
              <div className="empty-compact">These runs contain no comparable cases.</div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
};

export { DiffPanel, createVerdictMatrix, type DiffPanelProps, type VerdictMatrix };
