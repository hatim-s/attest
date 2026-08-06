import { describe, expect, it } from 'vitest';

import type { MetricContext } from '../metric-evaluation.js';
import { buildMetricRequest } from './metric-request.js';

/** Builds a completed metric context for the pure request-envelope boundary. */
const createMetricContext = (): MetricContext => ({
  caseDefinition: {
    id: 'greeting',
    input: { locale: 'en' },
    expected: { greeting: 'hello' },
    params: { formal: false },
  },
  execution: { outcome: 'completed', output: 'hello', trace: null },
});

describe('buildMetricRequest', () => {
  it('creates the metric contract §2 envelope and represents an absent trace as null', () => {
    expect(buildMetricRequest(createMetricContext())).toEqual({
      protocol: 'attest.metric/v1alpha1',
      case: {
        id: 'greeting',
        input: { locale: 'en' },
        expected: { greeting: 'hello' },
        params: { formal: false },
      },
      output: 'hello',
      trace: null,
    });
  });
});
