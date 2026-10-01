import { expect, it } from 'vitest';

import { redactMetricEvaluation } from '../eval-metric-runner.js';

it('redacts evidence without changing metric identity, kind, or status', () => {
  const evaluation = redactMetricEvaluation(
    {
      metricName: 'quality',
      kind: 'exec',
      status: 'evaluated',
      result: {
        score: 1,
        pass: true,
        rationale: 'quality evaluated exec',
        details: { token: 'hidden', output: 'quality' },
      },
    },
    ['quality', 'evaluated', 'exec'],
  );
  expect(evaluation).toMatchObject({
    metricName: 'quality',
    kind: 'exec',
    status: 'evaluated',
    result: {
      score: 1,
      pass: true,
      rationale: '[REDACTED] [REDACTED] [REDACTED]',
      details: { token: '[REDACTED]', output: '[REDACTED]' },
    },
  });
});

it('preserves error codes while redacting error messages and evidence', () => {
  const evaluation = redactMetricEvaluation(
    {
      metricName: 'quality',
      kind: 'exec',
      status: 'error',
      error: {
        code: 'exec_spawn_failed',
        message: 'exec_spawn_failed with credential',
        details: { diagnostic: 'credential' },
      },
      judgeIo: { response: 'credential' },
    },
    ['error', 'exec_spawn_failed', 'credential'],
  );
  expect(evaluation).toMatchObject({
    status: 'error',
    error: {
      code: 'exec_spawn_failed',
      message: '[REDACTED] with [REDACTED]',
      details: { diagnostic: '[REDACTED]' },
    },
    judgeIo: { response: '[REDACTED]' },
  });
});
