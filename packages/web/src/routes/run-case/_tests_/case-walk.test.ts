import type { CaseSummary } from '@attest/core/records';
import { expect, it } from 'vitest';
import { caseWalk } from '../case-walk.js';

const summary = (caseId: string, verdict: CaseSummary['verdict']): CaseSummary => ({
  caseId,
  suiteName: 'refunds',
  outcome: verdict === 'error' ? 'invocation_error' : 'completed',
  verdict,
  startedAt: '2026-11-01T00:00:00.000Z',
  durationMs: 10,
  metricCounts: { expected: 1, evaluated: 1, passed: verdict === 'pass' ? 1 : 0, errors: 0 },
});

const cases = [
  summary('a', 'fail'),
  summary('b', 'pass'),
  summary('c', 'pass'),
  summary('d', 'error'),
  summary('e', 'pass'),
];

const ids = (walk: ReturnType<typeof caseWalk>) => ({
  previous: walk.previous?.caseId,
  next: walk.next?.caseId,
  nextFailure: walk.nextFailure?.caseId,
});

it('finds the next failure after the case, then wraps to the start of the run', () => {
  expect(ids(caseWalk(cases, 'b'))).toEqual({ previous: 'a', next: 'c', nextFailure: 'd' });
  expect(ids(caseWalk(cases, 'd'))).toEqual({ previous: 'c', next: 'e', nextFailure: 'a' });
  expect(ids(caseWalk(cases, 'e'))).toEqual({ previous: 'd', next: undefined, nextFailure: 'a' });
});

it('never offers the open case as its own next failure', () => {
  const single = [summary('a', 'pass'), summary('b', 'fail')];

  expect(caseWalk(single, 'b').nextFailure).toBeUndefined();
});

it('starts from the first failure when the case is not among the loaded rows', () => {
  expect(ids(caseWalk(cases, 'zz'))).toEqual({
    previous: undefined,
    next: undefined,
    nextFailure: 'a',
  });
});
