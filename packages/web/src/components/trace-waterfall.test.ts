import { describe, expect, it } from 'vitest';

import { createTraceWaterfallRows, readTraceSpans } from './trace-waterfall.js';

describe('trace waterfall projection', () => {
  it('sorts spans, computes hierarchy depth, and aligns the shared timeline', () => {
    const trace = {
      spans: [
        {
          span_id: 'child',
          parent_span_id: 'root',
          name: 'tool.call',
          kind: 'tool',
          start_time: '2026-08-07T00:00:00.250Z',
          end_time: '2026-08-07T00:00:00.750Z',
          status: { code: 'ok' },
        },
        {
          span_id: 'root',
          parent_span_id: null,
          name: 'agent.run',
          kind: 'agent',
          start_time: '2026-08-07T00:00:00.000Z',
          end_time: '2026-08-07T00:00:01.000Z',
          status: { code: 'ok' },
        },
      ],
    };

    expect(createTraceWaterfallRows(trace)).toMatchObject([
      { spanId: 'root', depth: 0, durationMs: 1_000, offsetPercent: 0, widthPercent: 100 },
      { spanId: 'child', depth: 1, durationMs: 500, offsetPercent: 25, widthPercent: 50 },
    ]);
  });

  it('drops malformed spans and bounds cyclic parents', () => {
    const trace = {
      spans: [
        {
          span_id: 'one',
          parent_span_id: 'two',
          name: 'one',
          start_time: '2026-08-07T00:00:00.000Z',
          end_time: '2026-08-07T00:00:00.100Z',
        },
        {
          span_id: 'two',
          parent_span_id: 'one',
          name: 'two',
          start_time: '2026-08-07T00:00:00.010Z',
          end_time: '2026-08-07T00:00:00.090Z',
        },
        { span_id: 'bad' },
      ],
    };

    expect(readTraceSpans(trace)).toHaveLength(2);
    expect(createTraceWaterfallRows(trace).map(({ depth }) => depth)).toEqual([0, 0]);
  });
});
