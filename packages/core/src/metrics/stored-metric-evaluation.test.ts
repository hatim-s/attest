import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { MetricErrorInfo, MetricEvaluation } from './metric-evaluation.js';
import {
  fromStoredMetricEvaluation,
  toStoredMetricEvaluation,
} from './stored-metric-evaluation.js';

const evaluatedFixtures: MetricEvaluation[] = [
  {
    metricName: 'assertion-pass',
    kind: 'assertion',
    status: 'evaluated',
    result: { score: 1, pass: true },
    durationMs: 2,
  },
  {
    metricName: 'judge-fail',
    kind: 'judge',
    status: 'evaluated',
    result: {
      score: 0.4,
      pass: false,
      rationale: 'Missing source.',
      details: { usage: { inputTokens: 10 } },
    },
    judgeIo: { request: { model: 'openai/example' }, cache: 'miss' },
    durationMs: 3,
  },
  {
    metricName: 'assertion-rationale',
    kind: 'assertion',
    status: 'evaluated',
    result: { score: 0.5, pass: false, rationale: 'One assertion did not hold.' },
    durationMs: 3,
  },
  {
    metricName: 'exec-details',
    kind: 'exec',
    status: 'evaluated',
    result: { score: 0.75, pass: true, details: { source: 'custom metric' } },
    durationMs: 4,
  },
  {
    metricName: 'judge-evidence',
    kind: 'judge',
    status: 'evaluated',
    result: { score: 1, pass: true },
    judgeIo: { request: { model: 'openai/example' }, cache: 'hit' },
    durationMs: 5,
  },
];

const errorCodes: MetricErrorInfo['code'][] = [
  'exec_spawn_failed',
  'exec_timeout',
  'exec_nonzero_exit',
  'exec_malformed_output',
  'http_request_failed',
  'http_bad_status',
  'judge_provider_error',
  'judge_unparseable_response',
  'internal_error',
  'invalid_json_schema',
  'invalid_path',
  'skipped_no_output',
];

const errorFixtures: MetricEvaluation[] = errorCodes.map((code, index) => ({
  metricName: `error-${code}`,
  kind: 'exec',
  status: 'error',
  error: { code, message: `message-${code}`, details: { index } },
  durationMs: index,
}));

describe('stored metric evaluation mapping', () => {
  it('round-trips every representative runtime arm losslessly', () => {
    fc.assert(
      fc.property(fc.constantFrom(...evaluatedFixtures, ...errorFixtures), (evaluation) => {
        expect(fromStoredMetricEvaluation(toStoredMetricEvaluation(evaluation))).toEqual(
          evaluation,
        );
      }),
    );
  });

  it('round-trips every representative stored arm losslessly', () => {
    const storedFixtures = [...evaluatedFixtures, ...errorFixtures].map(toStoredMetricEvaluation);

    fc.assert(
      fc.property(fc.constantFrom(...storedFixtures), (stored) => {
        expect(toStoredMetricEvaluation(fromStoredMetricEvaluation(stored))).toEqual(stored);
      }),
    );
  });
});
