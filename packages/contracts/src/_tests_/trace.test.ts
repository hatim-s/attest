import { describe, expect, it } from 'vitest';

import { parseTrace } from '../schema/parse.js';
import { traceSchema } from '../trace/protocol.js';
import { TRACE_SCHEMA_ID } from '../schema/identifiers.js';

const traceFixture = {
  schema: TRACE_SCHEMA_ID,
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
  it.each([
    {
      field: 'start_time',
      value: '2026-08-06T10:15:03.120+05:30',
      path: ['spans', 0, 'start_time'],
    },
    { field: 'kind', value: 'database', path: ['spans', 0, 'kind'] },
  ])('rejects an invalid $field at its source path', ({ field, value, path }) => {
    const trace = { ...traceFixture, spans: [{ ...traceFixture.spans[0], [field]: value }] };

    const result = traceSchema.safeParse(trace);

    expect(result.success).toBe(false);

    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.path).toEqual(path);
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
});
