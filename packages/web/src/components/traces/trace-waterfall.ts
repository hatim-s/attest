import type { CaseRecord } from '@attest/core/records';

type CaseTrace = Extract<CaseRecord, { outcome: 'completed' }>['trace'];

type RecordedSpan = NonNullable<CaseTrace>['spans'][number];

type TraceSpan = {
  /** The recorded span, for its attributes, input and output. */
  span: RecordedSpan;
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

type TraceWaterfallLayout = {
  durationMs: number;
  rows: TraceWaterfallRow[];
  /** When the earliest span started, in epoch milliseconds; step offsets count from here. */
  startTime: number;
};

/** Keeps parent cycles finite while projecting validated spans onto one timeline. */
const createTraceWaterfall = (trace: CaseTrace): TraceWaterfallLayout => {
  const spans: TraceSpan[] = (trace?.spans ?? []).map((span) => ({
    span,
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

  if (spans.length === 0) return { durationMs: 0, rows: [], startTime: 0 };
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

  return { durationMs: traceEnd - traceStart, rows, startTime: traceStart };
};

export { createTraceWaterfall, type CaseTrace, type TraceWaterfallRow };
