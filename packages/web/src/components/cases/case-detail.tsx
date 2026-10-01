import { useEffect, useRef, type ReactNode } from 'react';

import type { CaseRecord, CaseSummary, StoredMetricEvaluation } from '../../api/types.js';
import { formatDuration } from '../../lib/format.js';
import { TraceWaterfall } from '../traces/trace-waterfall.js';
import { Badge, Button, ErrorNotice, Loading } from '../shared/ui.js';

type DetailSectionProps = { children: ReactNode; label: string };

/** One titled block in the case drawer. */
const DetailSection = ({ children, label }: DetailSectionProps) => (
  <section className="detail-section">
    <h4>{label}</h4>
    {children}
  </section>
);

const JsonBlock = ({ value }: { value: unknown }) => <pre>{JSON.stringify(value, null, 2)}</pre>;

/** Renders one stored metric evaluation. Error results show the error message as the rationale. */
const MetricRow = ({ metric }: { metric: StoredMetricEvaluation }) => {
  if (metric.status === 'error') {
    return (
      <div className="metric-row">
        <span>
          <Badge tone="error">error</Badge>
        </span>
        <strong>{metric.metricName}</strong>
        <span className="mono">—</span>
        <span className="metric-rationale">{metric.rationale ?? metric.error.message}</span>
      </div>
    );
  }
  return (
    <div className="metric-row">
      <span>
        <Badge tone={metric.pass ? 'pass' : 'fail'}>{metric.pass ? 'passed' : 'failed'}</Badge>
      </span>
      <strong>{metric.metricName}</strong>
      <span className="mono">{metric.score}</span>
      <span className="metric-rationale">{metric.rationale ?? ''}</span>
    </div>
  );
};

type CaseDetailProps = {
  caseRecord?: CaseRecord;
  error: unknown;
  isLoading: boolean;
  onClose: () => void;
  selected: CaseSummary;
};

/** Side drawer with the metrics, request, response, trace, and warnings for one case. */
const CaseDetail = ({ caseRecord, error, isLoading, onClose, selected }: CaseDetailProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef(document.activeElement);
  useEffect(() => {
    const dialog = dialogRef.current;
    // The native dialog traps focus and restores it when the evidence panel closes.
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);
  return (
    <dialog
      className="drawer-backdrop"
      aria-label={`Case ${selected.caseId}`}
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label={`Case ${selected.caseId}`}
        className="case-drawer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div>
            <p className="eyebrow">{selected.suiteName}</p>
            <h3>{selected.caseId}</h3>
          </div>
          <Button aria-label="Close case detail" onClick={onClose} tone="ghost">
            Close
          </Button>
        </header>
        <div className="drawer-meta">
          <Badge tone={selected.verdict}>{selected.verdict}</Badge>
          <span>{formatDuration(selected.durationMs)}</span>
          <span>{selected.outcome}</span>
        </div>
        {isLoading ? <Loading label="Loading case evidence" /> : null}
        {error !== null && error !== undefined ? <ErrorNotice error={error} /> : null}
        {caseRecord !== undefined ? (
          <div className="drawer-content">
            <DetailSection label="Metrics">
              <div className="metric-list">
                {caseRecord.metrics.map((metric) => (
                  <MetricRow key={metric.metricName} metric={metric} />
                ))}
              </div>
            </DetailSection>
            <DetailSection label="Request">
              <JsonBlock value={caseRecord.request} />
            </DetailSection>
            <DetailSection label="Response">
              <JsonBlock
                value={
                  caseRecord.outcome === 'completed'
                    ? caseRecord.response
                    : { errorCode: caseRecord.errorCode, errorMessage: caseRecord.errorMessage }
                }
              />
            </DetailSection>
            {caseRecord.outcome === 'completed' && caseRecord.trace !== undefined ? (
              <DetailSection label="Trace">
                <TraceWaterfall trace={caseRecord.trace} />
              </DetailSection>
            ) : null}
            {caseRecord.warnings.length > 0 ? (
              <DetailSection label="Warnings">
                <JsonBlock value={caseRecord.warnings} />
              </DetailSection>
            ) : null}
          </div>
        ) : null}
      </aside>
    </dialog>
  );
};

export { CaseDetail, type CaseDetailProps };
