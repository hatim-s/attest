import { describe, expect, it } from 'vitest';

import { parsePiRecord, toolResultText } from '../pi/pi-records.js';

const assistant = {
  role: 'assistant',
  content: [{ type: 'text', text: 'answer', extra: true }],
  model: 'model',
  usage: { input: 1, output: 2, extra: true },
  stopReason: 'stop',
};

describe('Pi native record decoding', () => {
  it('retains extensions at every declared loose object', () => {
    expect(
      parsePiRecord(JSON.stringify({ type: 'message_end', message: assistant, extra: 1 })),
    ).toEqual({
      ok: true,
      record: { type: 'message_end', message: assistant, extra: 1 },
    });
    expect(
      toolResultText({ content: [{ type: 'text', text: 'tool', extra: true }], details: {} }),
    ).toBe('tool');
  });

  it('drops unhandled records and non-assistant messages but rejects malformed assistants', () => {
    expect(parsePiRecord('{"type":"queue_update"}')).toEqual({ ok: true, record: undefined });
    expect(parsePiRecord('{"type":"message_end","message":{"role":"user"}}')).toEqual({
      ok: true,
      record: { type: 'message_end', message: null },
    });
    expect(
      parsePiRecord(JSON.stringify({ type: 'message_end', message: { ...assistant, usage: {} } })),
    ).toMatchObject({ ok: false });
    expect(parsePiRecord('{"type":"agent_settled","aborted":"false"}')).toMatchObject({
      ok: false,
    });
  });
});
