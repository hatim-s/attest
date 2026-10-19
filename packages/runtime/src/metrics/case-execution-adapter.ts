import { isAgentErrorResponse, type TestCase } from '@attest/contracts';
import type { CaseExecution } from '../eval/types.js';

import type { MetricContext } from './metric-evaluation.js';

/** The execution fields metrics read, picked per outcome so a completed view keeps its response. */
type CaseExecutionView =
  | Pick<Extract<CaseExecution, { outcome: 'completed' }>, 'outcome' | 'response' | 'trace'>
  | Pick<Exclude<CaseExecution, { outcome: 'completed' }>, 'outcome'>;

/** Maps the runner's terminal case shape to the narrow context every metric consumes. */
const caseExecutionToMetricContext = (
  caseDefinition: TestCase,
  execution: CaseExecutionView,
): MetricContext => {
  if (execution.outcome !== 'completed') {
    return { caseDefinition, execution: { outcome: execution.outcome, trace: null } };
  }

  const trace = execution.trace ?? null;

  if (isAgentErrorResponse(execution.response)) {
    return { caseDefinition, execution: { outcome: 'agent_error', trace } };
  }

  return {
    caseDefinition,
    execution: {
      outcome: 'completed',
      output: execution.response.output,
      trace,
      artifacts: execution.response.artifacts ?? [],
    },
  };
};

export { caseExecutionToMetricContext, type CaseExecutionView };
