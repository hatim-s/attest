import type { ReactNode } from 'react';

import type { CaseRecord, StoredMetricEvaluation } from '@attest/core/records';
import { caseRecordVerdict } from '@attest/core/records';
import { formatDuration } from '../../lib/format.js';
import { TraceWaterfall } from '../traces/trace-waterfall.js';
import { Drawer } from '../shared/drawer.js';
import { Badge, ErrorNotice, Loading } from '../shared/ui.js';

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
  selected: { suiteName: string; caseId: string };
};

/** Side drawer with the metrics, request, response, trace, and warnings for one case. */
const CaseDetail = ({ caseRecord, error, isLoading, onClose, selected }: CaseDetailProps) => {
  const verdict = caseRecord === undefined ? undefined : caseRecordVerdict(caseRecord);

  return (
    <Drawer
      label={`Case ${selected.caseId}`}
      eyebrow={selected.suiteName}
      title={selected.caseId}
      closeLabel="Close case detail"
      onClose={onClose}
    >
      {caseRecord !== undefined ? (
        <div className="drawer-meta">
          {verdict !== undefined ? <Badge tone={verdict}>{verdict}</Badge> : null}
          <span>{formatDuration(caseRecord.durationMs)}</span>
          <span>{caseRecord.outcome}</span>
        </div>
      ) : null}
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
    </Drawer>
  );
};

export { CaseDetail, type CaseDetailProps };
