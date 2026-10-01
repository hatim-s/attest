import type { AgentResponse, TestCase, Trace } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { caseExecutionToMetricContext } from '../case-execution-adapter.js';

const caseDefinition: TestCase = {
  id: 'capital',
  input: { question: 'What is the capital of France?' },
  expected: 'Paris',
};
const trace: Trace = { schema: 'attest.trace', trace_id: 'trace-1', spans: [] };
const successResponse: AgentResponse = { protocol: 'attest.agent-invocation', output: 'Paris' };
const errorResponse: AgentResponse = {
  protocol: 'attest.agent-invocation',
  error: { code: 'AGENT_ERROR', message: 'Agent could not answer.' },
};

describe('caseExecutionToMetricContext', () => {
  it.each([
    [successResponse, undefined, { outcome: 'completed', output: 'Paris', trace: null }],
    [errorResponse, undefined, { outcome: 'agent_error', trace: null }],
    [successResponse, trace, { outcome: 'completed', output: 'Paris', trace }],
    [errorResponse, trace, { outcome: 'agent_error', trace }],
  ] as const)(
    'maps a completed %o response with trace %o',
    (response, executionTrace, expected) => {
      const context = caseExecutionToMetricContext(caseDefinition, {
        outcome: 'completed',
        response,
        trace: executionTrace,
      });

      expect(context.execution).toEqual(expected);
    },
  );

  it.each(['invocation_error', 'timeout', 'cancelled'] as const)(
    'maps %s executions without weakening the runner union',
    (outcome) => {
      const context = caseExecutionToMetricContext(caseDefinition, { outcome });

      expect(context.execution).toEqual({ outcome, trace: null });
    },
  );
});
