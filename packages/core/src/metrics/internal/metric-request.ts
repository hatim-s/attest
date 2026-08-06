import { METRIC_PROTOCOL, type MetricRequest } from '@attest/contracts';

import type { MetricContext } from '../metric-evaluation.js';

/**
 * Assembles the attest.metric/v1alpha1 request envelope from the evaluation document (spec §2).
 * Keeping this pure lets every executable transport send precisely the same case evidence.
 */
const buildMetricRequest = (context: MetricContext): MetricRequest => ({
  protocol: METRIC_PROTOCOL,
  case: {
    id: context.caseDefinition.id,
    input: context.caseDefinition.input,
    ...(context.caseDefinition.expected === undefined
      ? {}
      : { expected: context.caseDefinition.expected }),
    ...(context.caseDefinition.params === undefined
      ? {}
      : { params: context.caseDefinition.params }),
  },
  // A completed runner result normally always has output; null still preserves a valid JSON envelope
  // for a defensive incomplete result instead of omitting the protocol-required field.
  output: context.execution.output ?? null,
  trace: context.execution.trace,
});

export { buildMetricRequest };
