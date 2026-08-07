import type { AgentResponse, CaseDefinition, CaseOutcome, Trace } from '@attest/contracts';

import type { MetricContext } from './metric-evaluation.js';

/** Structural view of the runner track's CaseExecution — field-compatible by construction, verified at the Phase 1 gate. */
type CaseExecutionView = {
  caseId: string;
  trace?: Trace;
} & (
  { outcome: 'completed'; response: AgentResponse } | { outcome: Exclude<CaseOutcome, 'completed'> }
);

/** Reports an impossible completed runner view before metrics can mis-score its absent output. */
class CaseExecutionAdapterError extends Error {
  readonly code = 'INVALID_CASE_EXECUTION';

  constructor(message: string) {
    super(message);
    this.name = 'CaseExecutionAdapterError';
  }
}

/** Maps the runner's terminal case shape to the narrow context every metric consumes. */
const caseExecutionToMetricContext = (
  caseDefinition: CaseDefinition,
  execution: CaseExecutionView,
): MetricContext => {
  const trace = execution.trace ?? null;
  if (execution.outcome !== 'completed') {
    return { caseDefinition, execution: { outcome: execution.outcome, trace } };
  }

  if (execution.response === undefined) {
    throw new CaseExecutionAdapterError(
      `Completed case execution ${execution.caseId} is missing its agent response.`,
    );
  }

  if ('output' in execution.response) {
    return {
      caseDefinition,
      execution: { outcome: 'completed', output: execution.response.output, trace },
    };
  }

  return { caseDefinition, execution: { outcome: 'agent_error', trace } };
};

export { CaseExecutionAdapterError, caseExecutionToMetricContext, type CaseExecutionView };
