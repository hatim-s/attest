import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  agentRequestSchema,
  agentResponseSchema,
  type AgentErrorResponse,
  type AgentResponse,
  type AgentSuccessResponse,
} from '../agent/protocol.js';
import { parseAgentRequest, parseAgentResponse } from '../schema/parse.js';
import { AGENT_PROTOCOL } from '../schema/identifiers.js';

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

  it('is exposed through the non-throwing request parser', () => {
    const result = parseAgentRequest({
      protocol: AGENT_PROTOCOL,
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      case_id: 'greeting-basic',
      input: {},
    });

    expect(result.ok).toBe(true);
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

    expect(result.errors).toContainEqual({
      path: 'output',
      message: 'exactly one of output or error must be present',
    });
  });

  it('keeps a valid response and warns when its trace is malformed', () => {
    const result = parseAgentResponse({
      protocol: AGENT_PROTOCOL,
      output: 'Paris',
      trace: { schema: 'wrong-version' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.trace).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'invalid_trace', path: 'trace' }),
    ]);
    expect(result.warnings[0]?.message).toContain('schema');
  });

  it('preserves and warns for each unknown response field', () => {
    const result = parseAgentResponse({
      protocol: AGENT_PROTOCOL,
      output: 'Paris',
      vendor_response: { cached: true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(Reflect.get(result.value, 'vendor_response')).toEqual({ cached: true });
    expect(result.warnings).toEqual([
      {
        code: 'unknown_field',
        path: 'vendor_response',
        message: 'unknown top-level response field preserved: vendor_response',
      },
    ]);
  });

  it('infers a response union that narrows to one terminal outcome', () => {
    expectTypeOf<AgentResponse>().toEqualTypeOf<AgentSuccessResponse | AgentErrorResponse>();

    const readOutcome = (response: AgentResponse): unknown => {
      if ('output' in response) {
        expectTypeOf(response).toEqualTypeOf<AgentSuccessResponse>();
        return response.output;
      }

      expectTypeOf(response).toEqualTypeOf<AgentErrorResponse>();
      return response.error;
    };

    expect(readOutcome({ protocol: AGENT_PROTOCOL, output: 'Paris' })).toBe('Paris');
  });
});
