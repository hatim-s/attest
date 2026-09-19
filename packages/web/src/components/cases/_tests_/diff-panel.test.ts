import { describe, expect, it } from 'vitest';

import type { CaseTransition } from '../../../api/types.js';
import { createVerdictMatrix } from '../diff-panel.js';

describe('createVerdictMatrix', () => {
  it('counts only transitions with both verdicts', () => {
    const transitions: CaseTransition[] = [
      {
        suiteName: 'suite',
        caseId: 'stable',
        kind: 'still_passing',
        baseVerdict: 'pass',
        candidateVerdict: 'pass',
        metricDeltas: [],
      },
      {
        suiteName: 'suite',
        caseId: 'regression',
        kind: 'regressed',
        baseVerdict: 'pass',
        candidateVerdict: 'fail',
        metricDeltas: [],
      },
      {
        suiteName: 'suite',
        caseId: 'new',
        kind: 'added',
        candidateVerdict: 'pass',
        metricDeltas: [],
      },
    ];

    expect(createVerdictMatrix(transitions)).toEqual({
      pass: { pass: 1, fail: 1, error: 0 },
      fail: { pass: 0, fail: 0, error: 0 },
      error: { pass: 0, fail: 0, error: 0 },
    });
  });
});
