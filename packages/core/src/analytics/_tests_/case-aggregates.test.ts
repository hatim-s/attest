import { describe, expect, it } from 'vitest';
import type { CaseSummary } from '../../records/projection-schemas.js';
import { aggregateCases, summarizeSuites } from '../case-aggregates.js';

const summary = (overrides: Partial<CaseSummary> = {}): CaseSummary => ({
  caseId: 'one',
  suiteName: 'suite',
  outcome: 'completed',
  verdict: 'pass',
  startedAt: '2026-10-18T00:00:00.000Z',
  durationMs: 10,
  metricCounts: { expected: 1, evaluated: 1, passed: 1, errors: 0 },
  ...overrides,
});

describe('case aggregates', () => {
  it.each([
    [[7], { p50: 7, p95: 7 }],
    [[20, 10], { p50: 10, p95: 20 }],
    [Array.from({ length: 20 }, (_, index) => 20 - index), { p50: 10, p95: 19 }],
  ] as const)('uses observed nearest-rank durations for %j', (durations, expected) => {
    const [first, ...rest] = durations;

    if (first === undefined) throw new Error('Missing duration fixture.');

    const cases = [
      summary({ durationMs: first }),
      ...rest.map((durationMs) => summary({ durationMs })),
    ] as const;

    const original = structuredClone(cases);
    expect(aggregateCases(cases).durationMs).toEqual(expected);
    expect(cases).toEqual(original);
  });

  it('keeps an unscored mean unknown', () => {
    expect(aggregateCases([summary()])).toMatchObject({ meanScore: null, scoredCaseCount: 0 });
  });

  it('counts errors as not passing and averages only scored cases including zero', () => {
    expect(
      aggregateCases([
        summary({ score: 0 }),
        summary({ verdict: 'fail', score: 1 }),
        summary({
          verdict: 'error',
          metricCounts: { expected: 3, evaluated: 3, passed: 0, errors: 3 },
        }),
      ]),
    ).toEqual({
      caseCount: 3,
      verdicts: { pass: 1, fail: 1, error: 1 },
      passRate: 1 / 3,
      scoredCaseCount: 2,
      meanScore: 0.5,
      durationMs: { p50: 10, p95: 10 },
      metricErrorCount: 3,
    });
  });

  it('groups suites before aggregating and sorts their names', () => {
    expect(
      summarizeSuites([
        summary({ suiteName: 'z', verdict: 'fail' }),
        summary({ suiteName: 'a' }),
        summary({ suiteName: 'Z' }),
        summary({ suiteName: 'z' }),
      ]),
    ).toMatchObject([
      { suiteName: 'Z', caseCount: 1, passRate: 1 },
      { suiteName: 'a', caseCount: 1, passRate: 1 },
      { suiteName: 'z', caseCount: 2, passRate: 0.5 },
    ]);
    expect(summarizeSuites([])).toEqual([]);
  });
});
