import { describe, expect, it } from 'vitest';

import type { CaseRecord } from '../../../api/types.js';

import { createTraceWaterfall } from '../trace-waterfall.js';

describe('trace waterfall projection', () => {
  it('sorts spans, computes hierarchy depth, and aligns the shared timeline', () => {
    const trace = {
      schema: 'attest.trace',
      trace_id: 'trace-one',
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
    } satisfies NonNullable<Extract<CaseRecord, { outcome: 'completed' }>['trace']>;

    expect(createTraceWaterfall(trace).rows).toMatchObject([
      { spanId: 'root', depth: 0, durationMs: 1_000, offsetPercent: 0, widthPercent: 100 },
      { spanId: 'child', depth: 1, durationMs: 500, offsetPercent: 25, widthPercent: 50 },
    ]);
    expect(createTraceWaterfall(trace).durationMs).toBe(1_000);
  });

  it('bounds cyclic parents', () => {
    const trace = {
      schema: 'attest.trace',
      trace_id: 'trace-one',
      spans: [
        {
          span_id: 'one',
          parent_span_id: 'two',
          name: 'one',
          kind: 'agent',
          status: { code: 'ok' },
          start_time: '2026-08-07T00:00:00.000Z',
          end_time: '2026-08-07T00:00:00.100Z',
        },
        {
          span_id: 'two',
          parent_span_id: 'one',
          name: 'two',
          kind: 'tool',
          status: { code: 'ok' },
          start_time: '2026-08-07T00:00:00.010Z',
          end_time: '2026-08-07T00:00:00.090Z',
        },
      ],
    } satisfies NonNullable<Extract<CaseRecord, { outcome: 'completed' }>['trace']>;

    expect(createTraceWaterfall(trace).rows.map(({ depth }) => depth)).toEqual([0, 0]);
  });
});
