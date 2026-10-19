import { METRIC_PROTOCOL, type MetricRequest } from '@attest/contracts';

import type { CompletedMetricContext } from '../metric-evaluation.js';

/**
 * Assembles the attest.metric-evaluation request envelope. Both executable transports send this
 * body, so command and HTTP metrics see the same case evidence. `artifact_dir` stays null until a
 * command transport writes the artifacts somewhere and fills it in.
 */
const buildMetricRequest = (context: CompletedMetricContext): MetricRequest => ({
  protocol: METRIC_PROTOCOL,
  case: {
    id: context.caseDefinition.id,
    input: context.caseDefinition.input,
    expected: context.caseDefinition.expected,
    params: context.caseDefinition.params,
  },
  output: context.execution.output,
  trace: context.execution.trace,
  artifacts: context.execution.artifacts,
  artifact_dir: null,
});

export { buildMetricRequest };
