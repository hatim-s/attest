import type { CaseRecord, CaseSummary, StoredMetricEvaluation } from '../../api/types.js';
import { formatDuration } from '../../lib/format.js';
import { TraceWaterfall } from '../traces/trace-waterfall.js';
import { Badge, Button, ErrorNotice, Loading } from '../shared/ui.js';

const JsonBlock = ({ label, value }: { label: string; value: unknown }) => (
  <section className="detail-section">
    <h4>{label}</h4>
    <pre>{JSON.stringify(value, null, 2)}</pre>
  </section>
);

/** Renders one stored metric evaluation by narrowing the evaluated/error union once. */
const MetricRow = ({ metric }: { metric: StoredMetricEvaluation }) => {
  if (metric.status === 'error') {
    return (
      <div className="metric-row" key={metric.metricName}>
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
    <div className="metric-row" key={metric.metricName}>
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

/** Presents the full case payload and metric evidence in an accessible side panel. */
const CaseDetail = ({ caseRecord, error, isLoading, onClose, selected }: CaseDetailProps) => (
  <div className="drawer-backdrop" onMouseDown={onClose} role="presentation">
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
                <MetricRow key={metric.metricName} metric={metric} />
              ))}
            </div>
          </section>
          <JsonBlock label="Request" value={caseRecord.request} />
          <JsonBlock
            label="Response"
            value={
              caseRecord.outcome === 'completed'
                ? caseRecord.response
                : {
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
  </div>
);

export { CaseDetail, type CaseDetailProps };
