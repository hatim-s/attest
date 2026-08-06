import type { AgentResponse, CaseDefinition, Trace } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { evaluateMetrics } from './evaluate-metrics.js';
import { skippedNoOutput, type MetricContext } from './metric-evaluation.js';
import { caseExecutionToMetricContext, type CaseExecutionView } from './case-execution-adapter.js';

const caseDefinition: CaseDefinition = {
  id: 'capital',
  input: { question: 'What is the capital of France?' },
  expected: 'Paris',
};
const trace: Trace = { schema: 'attest.trace/v1alpha1', trace_id: 'trace-1', spans: [] };
const successResponse: AgentResponse = { protocol: 'attest.agent/v1alpha1', output: 'Paris' };
const errorResponse: AgentResponse = {
  protocol: 'attest.agent/v1alpha1',
  error: { code: 'AGENT_ERROR', message: 'Agent could not answer.' },
};

/** Builds metric input through the canonical runner adapter rather than hand-assembling execution state. */
const createMetricContext = (execution: CaseExecutionView): MetricContext =>
  caseExecutionToMetricContext(caseDefinition, execution);

describe('caseExecutionToMetricContext', () => {
  it.each([
    ['completed', successResponse, undefined, 'completed', 'Paris'],
    ['completed', errorResponse, undefined, 'agent_error', undefined],
    ['invocation_error', successResponse, undefined, 'invocation_error', undefined],
    ['invocation_error', errorResponse, undefined, 'invocation_error', undefined],
    ['timeout', successResponse, undefined, 'timeout', undefined],
    ['timeout', errorResponse, undefined, 'timeout', undefined],
    ['cancelled', successResponse, undefined, 'cancelled', undefined],
    ['cancelled', errorResponse, undefined, 'cancelled', undefined],
    ['completed', successResponse, trace, 'completed', 'Paris'],
    ['completed', errorResponse, trace, 'agent_error', undefined],
    ['invocation_error', successResponse, trace, 'invocation_error', undefined],
    ['invocation_error', errorResponse, trace, 'invocation_error', undefined],
    ['timeout', successResponse, trace, 'timeout', undefined],
    ['timeout', errorResponse, trace, 'timeout', undefined],
    ['cancelled', successResponse, trace, 'cancelled', undefined],
    ['cancelled', errorResponse, trace, 'cancelled', undefined],
  ] as const)(
    'maps %s executions with %s envelopes and %s trace',
    (outcome, response, executionTrace, expectedOutcome, expectedOutput) => {
      const context = createMetricContext({
        caseId: caseDefinition.id,
        outcome,
        response,
        ...(executionTrace === undefined ? {} : { trace: executionTrace }),
      });

      expect(context.execution.outcome).toBe(expectedOutcome);
      expect(context.execution.trace).toBe(executionTrace ?? null);
      if (expectedOutput === undefined) {
        expect(context.execution).not.toHaveProperty('output');
      } else {
        expect(context.execution).toMatchObject({ output: expectedOutput });
      }
    },
  );

  it('rejects an impossible completed runner view that has no response', () => {
    expect(() => createMetricContext({ caseId: caseDefinition.id, outcome: 'completed' })).toThrow(
      'missing its agent response',
    );
  });

  it('skips an assertion metric for an agent-error envelope through the dispatcher', async () => {
    const context = createMetricContext({
      caseId: caseDefinition.id,
      outcome: 'completed',
      response: errorResponse,
    });
    const [evaluation] = await evaluateMetrics(
      [{ name: 'answer-exists', type: 'assertion', assert: [{ exists: { path: '$.output' } }] }],
      context,
    );

    expect(evaluation).toMatchObject({
      status: 'error',
      error: {
        code: 'skipped_no_output',
        message:
          'Metric was not evaluated because the agent returned an error envelope. Agent errors are diagnosable results, but metrics cannot score absent output.',
      },
    });
  });

  it('makes the agent-error skip distinct from a missing-output skip', () => {
    const context = createMetricContext({
      caseId: caseDefinition.id,
      outcome: 'completed',
      response: errorResponse,
    });

    const skip = skippedNoOutput('answer-exists', 'assertion', context.execution);
    expect(skip.status === 'error' ? skip.error.message : '').toContain('error envelope');
  });
});
