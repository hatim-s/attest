import { describe, expect, it } from 'vitest';

import type { CaseSummary } from '../../../api/types.js';
import { createScoreHistogram } from '../distribution-charts.js';

const createCase = (caseId: string, score?: number): CaseSummary => ({
  caseId,
  suiteName: 'suite',
  outcome: 'completed',
  verdict: 'pass',
  startedAt: '2026-08-07T00:00:00.000Z',
  durationMs: 10,
  ...(score === undefined ? {} : { score }),
  metricCounts: { expected: 1, evaluated: 1, passed: 1, errors: 0 },
});

describe('createScoreHistogram', () => {
  it('clamps normalized boundary scores and ignores missing values', () => {
    const cases = [
      createCase('below', -1),
      createCase('low', 0.2),
      createCase('middle', 0.55),
      createCase('high', 1),
      createCase('above', 2),
      createCase('missing'),
    ];

    expect(createScoreHistogram(cases).map(({ count }) => count)).toEqual([1, 1, 1, 0, 2]);
  });
});
