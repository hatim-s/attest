import type { EvalSlice } from '@attest/core/records';
import { expect, it } from 'vitest';
import { runChange } from '../run-verdict.js';

const counts = { planned: 4, recorded: 4, failed: 0, errored: 0, skipped: 0, metricErrors: 0 };

const base = {
  suiteName: 'refunds',
  createdAt: '2026-11-01T00:00:00.000Z',
  finishedAt: '2026-11-01T00:01:00.000Z',
  runStatus: 'completed',
  gitBranch: null,
  gitSha: null,
  meanScore: null,
} as const;

const complete = (runId: string, passed: number): EvalSlice => ({
  ...base,
  runId,
  state: 'complete',
  passRate: passed / 4,
  counts: { ...counts, passed, failed: 4 - passed, notRun: 0, scored: 0, scoreSum: 0 },
});

const partial = (runId: string, state: 'running' | 'incomplete'): EvalSlice => ({
  ...base,
  runId,
  state,
  runStatus: state === 'running' ? 'running' : 'cancelled',
  passRate: null,
  counts: { ...counts, recorded: 1, passed: 1, notRun: 3, scored: 0, scoreSum: 0 },
});

it('compares passes with the newest complete slice and skips partial ones', () => {
  const older = {
    items: [
      partial('r4', 'running'),
      partial('r3', 'incomplete'),
      complete('r2', 2),
      complete('r1', 4),
    ],
  };

  expect(runChange(complete('r5', 3), older)).toEqual({
    kind: 'compared',
    previousRunId: 'r2',
    delta: 1,
  });
  expect(runChange(complete('r5', 1), older)).toMatchObject({ previousRunId: 'r2', delta: -1 });
});

it('never compares a slice without a pass rate', () => {
  expect(runChange(partial('r5', 'running'), { items: [complete('r1', 4)] })).toBeNull();
  expect(runChange(partial('r5', 'incomplete'), { items: [complete('r1', 4)] })).toBeNull();
});

it('tells a first complete slice from one whose baseline is past the page read', () => {
  expect(runChange(complete('r2', 4), { items: [partial('r1', 'incomplete')] })).toEqual({
    kind: 'none',
  });
  expect(
    runChange(complete('r2', 4), { items: [partial('r1', 'incomplete')], nextCursor: 'more' }),
  ).toEqual({ kind: 'beyond', read: 1 });
});
