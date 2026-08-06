import { describe, expect, it } from 'vitest';

import { parseTrace } from './parse.js';
import { traceSchema } from './trace.js';
import { TRACE_SCHEMA_VERSION } from './versions.js';

const traceFixture = {
  schema: TRACE_SCHEMA_VERSION,
  trace_id: 'trace-1',
  spans: [
    {
      span_id: 'span-1',
      parent_span_id: null,
      name: 'agent.run',
      kind: 'agent',
      start_time: '2026-08-06T10:15:03.120Z',
      end_time: '2026-08-06T10:15:09.480Z',
      status: { code: 'ok' },
      attributes: { 'gen_ai.operation.name': 'invoke_agent' },
    },
  ],
};

describe('traceSchema', () => {
  it('accepts a complete trace document', () => {
    expect(traceSchema.safeParse(traceFixture).success).toBe(true);
  });

  it.each([
    {
      field: 'start_time',
      value: '2026-08-06T10:15:03.120+05:30',
      path: ['spans', 0, 'start_time'],
    },
    { field: 'kind', value: 'database', path: ['spans', 0, 'kind'] },
    { field: 'start_time', value: '2026-08-06T10:15Z', path: ['spans', 0, 'start_time'] },
  ])('rejects an invalid $field at its source path', ({ field, value, path }) => {
    const trace = structuredClone(traceFixture) as Record<string, unknown>;
    const spans = trace.spans as Array<Record<string, unknown>>;
    spans[0]![field] = value;

    const result = traceSchema.safeParse(trace);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.path).toEqual(path);
  });

  it('accepts timestamps with whole seconds and optional sub-seconds', () => {
    const wholeSeconds = structuredClone(traceFixture);
    wholeSeconds.spans[0]!.start_time = '2026-08-06T10:15:03Z';
    wholeSeconds.spans[0]!.end_time = '2026-08-06T10:15:09Z';

    expect(traceSchema.safeParse(wholeSeconds).success).toBe(true);
    expect(traceSchema.safeParse(traceFixture).success).toBe(true);
  });

  it('preserves exotic unknown document and span fields through parseTrace', () => {
    const trace = {
      ...traceFixture,
      vendor_document: { nested: ['alpha', { beta: true }] },
      spans: [
        {
          ...traceFixture.spans[0],
          vendor_span: { tuple: [1, 'two', false], nullable: null },
        },
      ],
    };

    const result = parseTrace(trace);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.vendor_document).toEqual(trace.vendor_document);
    expect(result.value.spans[0]?.vendor_span).toEqual(trace.spans[0]?.vendor_span);
  });

  it('preserves unknown status and event fields', () => {
    const trace = {
      ...structuredClone(traceFixture),
      spans: [
        {
          ...structuredClone(traceFixture).spans[0]!,
          status: { code: 'ok', vendor_status: 'queued' },
          events: [
            {
              name: 'handoff',
              time: traceFixture.spans[0]!.start_time,
              vendor_event: { source: 'sdk' },
            },
          ],
        },
      ],
    };

    const result = parseTrace(trace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.spans[0]?.status.vendor_status).toBe('queued');
      expect(result.value.spans[0]?.events?.[0]?.vendor_event).toEqual({ source: 'sdk' });
    }
  });

  it('rejects duplicate span ids at the duplicate span', () => {
    const trace = structuredClone(traceFixture);
    trace.spans.push({ ...trace.spans[0]! });

    const result = traceSchema.safeParse(trace);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['spans', 1, 'span_id']);
    }
  });
});
