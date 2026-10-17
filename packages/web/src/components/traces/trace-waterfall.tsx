import { useMemo, useRef } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';

import type { CaseRecord } from '../../api/types.js';

import { formatDuration } from '../../lib/format.js';
import { Badge } from '../shared/ui.js';

type CaseTrace = Extract<CaseRecord, { outcome: 'completed' }>['trace'];

type TraceSpan = {
  endTime: number;
  kind: NonNullable<CaseTrace>['spans'][number]['kind'];
  name: string;
  parentSpanId: string | null;
  spanId: string;
  startTime: number;
  status: NonNullable<CaseTrace>['spans'][number]['status']['code'];
};

type TraceWaterfallRow = TraceSpan & {
  depth: number;
  durationMs: number;
  offsetPercent: number;
  widthPercent: number;
};

type TraceWaterfallProps = {
  trace: CaseTrace;
};

type TraceWaterfallLayout = {
  durationMs: number;
  rows: TraceWaterfallRow[];
};

/** Keeps parent cycles finite while projecting validated spans onto one timeline. */
const createTraceWaterfall = (trace: CaseTrace): TraceWaterfallLayout => {
  const spans: TraceSpan[] = (trace?.spans ?? []).map((span) => ({
    endTime: Date.parse(span.end_time),
    kind: span.kind,
    name: span.name,
    parentSpanId: span.parent_span_id,
    spanId: span.span_id,
    startTime: Date.parse(span.start_time),
    status: span.status.code,
  }));

  spans.sort(
    (left, right) => left.startTime - right.startTime || left.spanId.localeCompare(right.spanId),
  );

  if (spans.length === 0) return { durationMs: 0, rows: [] };
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const traceStart = Math.min(...spans.map(({ startTime }) => startTime));
  const traceEnd = Math.max(...spans.map(({ endTime }) => endTime));
  // Zero-length traces still need a nonzero divisor for percentage positions.
  const traceDuration = Math.max(1, traceEnd - traceStart);

  const rows = spans.map((span) => {
    let depth = 0;
    let parentSpanId = span.parentSpanId;
    const visited = new Set([span.spanId]);

    while (parentSpanId !== null && depth < spans.length) {
      if (visited.has(parentSpanId)) {
        depth = 0;
        break;
      }

      const parent = byId.get(parentSpanId);

      if (parent === undefined) break;
      visited.add(parentSpanId);
      depth += 1;
      parentSpanId = parent.parentSpanId;
    }

    const durationMs = Math.max(0, span.endTime - span.startTime);

    return {
      ...span,
      depth,
      durationMs,
      offsetPercent: ((span.startTime - traceStart) / traceDuration) * 100,
      widthPercent: Math.max(0.7, (durationMs / traceDuration) * 100),
    };
  });

  return { durationMs: traceEnd - traceStart, rows };
};

/** Renders a trace as a virtualized span tree on a shared timeline. */
const TraceWaterfall = ({ trace }: TraceWaterfallProps) => {
  const { durationMs, rows } = useMemo(() => createTraceWaterfall(trace), [trace]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 44,
    getScrollElement: () => scrollRef.current,
    overscan: 8,
  });

  if (rows.length === 0) {
    return <div className="empty-compact">No renderable spans were recorded for this case.</div>;
  }

  return (
    <section className="trace-waterfall" aria-label="Trace waterfall">
      <div className="trace-overview">
        <div>
          <strong>{rows.length}</strong>
          <span>spans</span>
        </div>
        <div>
          <strong>{formatDuration(durationMs)}</strong>
          <span>trace duration</span>
        </div>
        <div className="trace-kind-legend">
          {[...new Set(rows.map(({ kind }) => kind))].map((kind) => (
            <Badge key={kind} tone="neutral">
              {kind}
            </Badge>
          ))}
        </div>
      </div>
      <div className="trace-waterfall-header">
        <span>Span hierarchy</span>
        <span>Timeline</span>
      </div>
      <div className="trace-waterfall-scroll" ref={scrollRef}>
        <div className="trace-waterfall-spacer" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;

            return (
              <div
                className="trace-waterfall-row"
                key={row.spanId}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <div
                  className="trace-span-label"
                  style={{ paddingLeft: Math.min(row.depth, 6) * 14 }}
                >
                  <span className={`trace-kind-dot trace-kind-${row.kind}`} />
                  <span>
                    <strong title={row.name}>{row.name}</strong>
                    <small>{formatDuration(row.durationMs)}</small>
                  </span>
                </div>
                <div className="trace-timeline">
                  <span
                    aria-label={`${row.name}, ${formatDuration(row.durationMs)}`}
                    className={`trace-bar trace-kind-${row.kind} ${row.status === 'error' ? 'trace-bar-error' : ''}`}
                    style={{ left: `${row.offsetPercent}%`, width: `${row.widthPercent}%` }}
                    title={`${row.name} · ${formatDuration(row.durationMs)}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export { TraceWaterfall, createTraceWaterfall, type TraceWaterfallProps };
