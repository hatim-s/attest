import type { EvalSlice } from '@attest/core/records';
import { expect, it } from 'vitest';
import { runDestination } from '../run-destination.js';

const slice = (suiteName: string): EvalSlice => ({
  runId: 'r1',
  suiteName,
  createdAt: '2026-11-01T00:00:00.000Z',
  finishedAt: null,
  runStatus: 'running',
  gitBranch: null,
  gitSha: null,
  meanScore: null,
  state: 'running',
  passRate: null,
  counts: {
    planned: null,
    recorded: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    skipped: 0,
    metricErrors: 0,
    scored: 0,
    scoreSum: 0,
    notRun: null,
  },
});

it('opens the only eval of a single-eval run', () => {
  expect(runDestination([slice('refunds')])).toEqual({ kind: 'eval', suiteName: 'refunds' });
});

it('lists the evals of a run with several or none recorded yet', () => {
  expect(runDestination([slice('refunds'), slice('tracking')])).toEqual({ kind: 'evals' });
  expect(runDestination([])).toEqual({ kind: 'evals' });
});
