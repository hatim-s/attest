import { METRIC_PROTOCOL, type MetricRequest } from '@attest/contracts';

import type { CompletedMetricContext } from '../metric-evaluation.js';

/**
 * Assembles the attest.metric-evaluation request envelope (spec §2). Both executable transports
 * send this exact body, so command and HTTP metrics see the same case evidence.
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
});

export { buildMetricRequest };
