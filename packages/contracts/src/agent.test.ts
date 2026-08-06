import { describe, expect, it } from 'vitest';

import { agentRequestSchema, agentResponseSchema } from './agent.js';
import { parseAgentResponse } from './parse.js';
import { AGENT_PROTOCOL } from './versions.js';

describe('agentRequestSchema', () => {
  it('accepts a complete multi-turn request', () => {
    const result = agentRequestSchema.safeParse({
      protocol: AGENT_PROTOCOL,
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      case_id: 'greeting-basic',
      input: { question: 'What is the capital of France?' },
      params: { locale: 'en' },
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      turn_index: 0,
      conversation_id: 'conversation-1',
      state: { cursor: 1 },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a partial multi-turn envelope at each missing field', () => {
    const result = agentRequestSchema.safeParse({
      protocol: AGENT_PROTOCOL,
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      case_id: 'greeting-basic',
      input: {},
      messages: [],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ['turn_index'],
      ['conversation_id'],
    ]);
  });

  it('retains unknown request fields', () => {
    const result = agentRequestSchema.safeParse({
      protocol: AGENT_PROTOCOL,
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      case_id: 'greeting-basic',
      input: {},
      vendor_request: { attempt: 2 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vendor_request).toEqual({ attempt: 2 });
    }
  });
});

describe('agentResponseSchema', () => {
  it('accepts a response with one output', () => {
    expect(
      agentResponseSchema.safeParse({ protocol: AGENT_PROTOCOL, output: { answer: 'Paris' } })
        .success,
    ).toBe(true);
  });

  it.each([
    { protocol: AGENT_PROTOCOL },
    { protocol: AGENT_PROTOCOL, output: 'Paris', error: { message: 'failed' } },
  ])('rejects a response without exactly one outcome', (response) => {
    const result = parseAgentResponse(response);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toContainEqual({
      path: 'output',
      message: 'exactly one of output or error must be present',
    });
  });
});
