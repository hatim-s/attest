import { describe, expect, it } from 'vitest';

import type { MetricEvaluation } from '../metric-evaluation.js';
import { toStoredMetricEvaluation } from '../stored-metric-evaluation.js';

describe('stored metric evaluation mapping', () => {
  it('preserves evaluated evidence without optional placeholders', () => {
    const evaluation: MetricEvaluation = {
      metricName: 'quality',
      kind: 'assertion',
      status: 'evaluated',
      result: { score: 1, pass: true, details: { source: 'fixture' } },
    };

    expect(toStoredMetricEvaluation(evaluation)).toEqual({
      metricName: 'quality',
      kind: 'assertion',
      status: 'evaluated',
      score: 1,
      pass: true,
      details: { source: 'fixture' },
    });
  });

  it('preserves future runtime error kinds and judge evidence', () => {
    const evaluation: MetricEvaluation = {
      metricName: 'future-provider',
      kind: 'judge',
      status: 'error',
      error: { code: 'future_provider_error', message: 'Provider unavailable.' },
      judgeIo: { request: { model: 'future/model' } },
      durationMs: 4,
    };

    expect(toStoredMetricEvaluation(evaluation)).toEqual({
      metricName: 'future-provider',
      kind: 'judge',
      status: 'error',
      error: { kind: 'future_provider_error', message: 'Provider unavailable.' },
      judgeIo: { request: { model: 'future/model' } },
      durationMs: 4,
    });
  });
});
