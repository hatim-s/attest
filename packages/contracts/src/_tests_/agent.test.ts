import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  type AgentErrorResponse,
  type AgentResponse,
  type AgentSuccessResponse,
} from '../agent/protocol.js';
import { parseAgentResponse } from '../schema/parse.js';
import { AGENT_PROTOCOL } from '../schema/identifiers.js';

describe('agentResponseSchema', () => {
  it.each([
    { protocol: AGENT_PROTOCOL, output: undefined },
    { protocol: AGENT_PROTOCOL, error: undefined },
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

  it('infers a response union that narrows to one terminal outcome', () => {
    expectTypeOf<AgentResponse>().toEqualTypeOf<AgentSuccessResponse | AgentErrorResponse>();

    const readOutcome = (
      response: AgentResponse,
    ): AgentSuccessResponse['output'] | AgentErrorResponse['error'] => {
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
