import type { EvalSlice, EvalSummary } from '@attest/core/records';
import { expect, it } from 'vitest';
import { projectStatus } from '../directory-status.js';

const slice = {
  runId: 'run-1',
  suiteName: 'smoke',
  createdAt: '2026-11-01T10:00:00.000Z',
  finishedAt: '2026-11-01T10:01:00.000Z',
  runStatus: 'completed',
  gitBranch: null,
  gitSha: null,
  counts: {
    planned: 2,
    recorded: 2,
    passed: 2,
    failed: 0,
    errored: 0,
    skipped: 0,
    metricErrors: 0,
    scored: 0,
    scoreSum: 0,
    notRun: 0,
  },
  meanScore: null,
  state: 'complete',
  passRate: 1,
} satisfies EvalSlice;

const evaluation = (suiteName: string, failing: boolean | null): EvalSummary => ({
  suiteName,
  latest: { ...slice, suiteName },
  latestComplete: { ...slice, suiteName },
  latestTerminal: { ...slice, suiteName },
  failing,
});

const status = (failing: readonly (boolean | null)[], runningRunCount = 0) =>
  projectStatus({
    evals: { items: failing.map((value, index) => evaluation(`eval-${index}`, value)) },
    runningRunCount,
  });

it('words a directory row from the overview verdicts, failures first', () => {
  expect(status([true, true, false], 1)).toEqual({ text: '2 evals failing', tone: 'failing' });
  expect(status([true])).toEqual({ text: '1 eval failing', tone: 'failing' });
  expect(status([false], 2)).toEqual({ text: 'Running', tone: 'running' });
  expect(status([], 1)).toEqual({ text: 'Running', tone: 'running' });
  expect(status([])).toEqual({ text: 'No runs yet', tone: 'none' });
  expect(status([false, false])).toEqual({ text: 'All passing', tone: 'passing' });
});

it('never counts an eval without a verdict as passing', () => {
  expect(status([null, null])).toEqual({ text: 'No verdict yet', tone: 'none' });
  expect(status([false, null])).toEqual({
    text: '1 passing, 1 without a verdict',
    tone: 'passing',
  });
});
