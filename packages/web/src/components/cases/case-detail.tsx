import { useEffect, useRef } from 'react';

import type { CaseRecord, CaseSummary } from '../../api/types.js';
import { formatDuration } from '../../lib/format.js';
import { TraceWaterfall } from '../traces/trace-waterfall.js';
import { Badge, Button, ErrorNotice, Loading } from '../shared/ui.js';

const JsonBlock = ({ label, value }: { label: string; value: unknown }) => (
  <section className="detail-section">
    <h4>{label}</h4>
    <pre>{JSON.stringify(value, null, 2)}</pre>
  </section>
);

type CaseDetailProps = {
  caseRecord?: CaseRecord;
  error: unknown;
  isLoading: boolean;
  onClose: () => void;
  selected: CaseSummary;
};

/** Presents the full case payload and metric evidence in an accessible side panel. */
const CaseDetail = ({ caseRecord, error, isLoading, onClose, selected }: CaseDetailProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef(document.activeElement);
  useEffect(() => {
    const dialog = dialogRef.current;
    // Native modal behavior keeps focus inside the evidence panel and restores it on close.
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  return (
    <dialog
      aria-label={`Case ${selected.caseId}`}
      className="drawer-backdrop"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      ref={dialogRef}
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
            <section className="detail-section">
              <h4>Metrics</h4>
              <div className="metric-list">
                {caseRecord.metrics.map((metric) => (
                  <div className="metric-row" key={metric.metricName}>
                    <span>
                      <Badge
                        tone={
                          metric.status === 'error'
                            ? 'error'
                            : metric.pass === false
                              ? 'fail'
                              : 'pass'
                        }
                      >
                        {metric.status === 'error'
                          ? 'error'
                          : metric.pass === false
                            ? 'failed'
                            : 'passed'}
                      </Badge>
                    </span>
                    <strong>{metric.metricName}</strong>
                    <span className="mono">{metric.score ?? '—'}</span>
                    <span className="metric-rationale">
                      {metric.rationale ?? metric.error?.message ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <JsonBlock label="Request" value={caseRecord.request} />
            <JsonBlock
              label="Response"
              value={
                caseRecord.response ?? {
                  errorCode: caseRecord.errorCode,
                  errorMessage: caseRecord.errorMessage,
                }
              }
            />
            {caseRecord.trace !== undefined ? (
              <section className="detail-section">
                <h4>Trace</h4>
                <TraceWaterfall trace={caseRecord.trace} />
              </section>
            ) : null}
            {caseRecord.warnings.length > 0 ? (
              <JsonBlock label="Warnings" value={caseRecord.warnings} />
            ) : null}
          </div>
        ) : null}
      </aside>
    </dialog>
  );
};

export { CaseDetail, type CaseDetailProps };
