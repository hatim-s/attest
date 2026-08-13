import { useMemo, useRef } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';

import { formatDuration } from '../../lib/format.js';
import { Badge } from '../shared/ui.js';

type TraceSpan = {
  endTime: number;
  kind: string;
  name: string;
  parentSpanId: string | null;
  spanId: string;
  startTime: number;
  status: string;
};

type TraceWaterfallRow = TraceSpan & {
  depth: number;
  durationMs: number;
  offsetPercent: number;
  widthPercent: number;
};

type TraceWaterfallProps = {
  trace: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const TRACE_KINDS = new Set(['agent', 'llm', 'tool', 'retrieval', 'other']);

/** Reads only the stable Attest span fields needed to render an untrusted stored trace. */
const readTraceSpans = (trace: unknown): TraceSpan[] => {
  const spans = asRecord(trace)?.spans;
  if (!Array.isArray(spans)) return [];
  return spans.flatMap((candidate) => {
    const span = asRecord(candidate);
    const startTime = Date.parse(String(span?.start_time ?? ''));
    const endTime = Date.parse(String(span?.end_time ?? ''));
    if (
      typeof span?.span_id !== 'string' ||
      typeof span.name !== 'string' ||
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime)
    ) {
      return [];
    }
    const status = asRecord(span.status)?.code;
    const kind = typeof span.kind === 'string' && TRACE_KINDS.has(span.kind) ? span.kind : 'other';
    return [
      {
        endTime,
        kind,
        name: span.name,
        parentSpanId: typeof span.parent_span_id === 'string' ? span.parent_span_id : null,
        spanId: span.span_id,
        startTime,
        status: typeof status === 'string' ? status : 'ok',
      },
    ];
  });
};

/** Builds bounded tree depths and normalized timeline positions for virtualized rendering. */
const createTraceWaterfallRows = (trace: unknown): TraceWaterfallRow[] => {
  const spans = readTraceSpans(trace).sort(
    (left, right) => left.startTime - right.startTime || left.spanId.localeCompare(right.spanId),
  );
  if (spans.length === 0) return [];
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const traceStart = Math.min(...spans.map(({ startTime }) => startTime));
  const traceEnd = Math.max(...spans.map(({ endTime }) => endTime));
  const traceDuration = Math.max(1, traceEnd - traceStart);

  return spans.map((span) => {
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
};

/** Renders a large trace as a virtualized hierarchy aligned to a shared duration axis. */
const TraceWaterfall = ({ trace }: TraceWaterfallProps) => {
  const rows = useMemo(() => createTraceWaterfallRows(trace), [trace]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 44,
    getScrollElement: () => scrollRef.current,
    overscan: 8,
  });
  const totalDuration =
    rows.length === 0
      ? 0
      : Math.max(...rows.map(({ endTime }) => endTime)) -
        Math.min(...rows.map(({ startTime }) => startTime));

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
          <strong>{formatDuration(totalDuration)}</strong>
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

export {
  TraceWaterfall,
  createTraceWaterfallRows,
  readTraceSpans,
  type TraceWaterfallProps,
  type TraceWaterfallRow,
};
