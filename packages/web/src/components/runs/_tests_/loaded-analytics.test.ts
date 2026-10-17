import { expect, it } from 'vitest';
import { createDurationHistogram, createRunTrends } from '../loaded-analytics.js';

it('places interval edges once and includes the observed maximum in the final bin', () => {
  const bins = createDurationHistogram([
    { durationMs: 0, verdict: 'pass' },
    { durationMs: 9.9, verdict: 'fail' },
    { durationMs: 10, verdict: 'error' },
    { durationMs: 99.9, verdict: 'pass' },
    { durationMs: 100, verdict: 'error' },
  ]);

  expect(bins.map((bin) => bin.counts)).toEqual([
    { pass: 1, fail: 1, error: 0 },
    { pass: 0, fail: 0, error: 1 },
    ...Array.from({ length: 7 }, () => ({ pass: 0, fail: 0, error: 0 })),
    { pass: 1, fail: 0, error: 1 },
  ]);
  expect(bins.at(-1)?.upperMs).toBe(100);
});

it('has no invented duration range for empty input and counts zero-duration cases', () => {
  expect(createDurationHistogram([])).toEqual([]);
  expect(createDurationHistogram([{ durationMs: 0, verdict: 'pass' }])[0]).toEqual({
    lowerMs: 0,
    upperMs: 1,
    counts: { pass: 1, fail: 0, error: 0 },
  });
});

const summary = {
  totalCases: 4,
  passedCases: 3,
  failedCases: 1,
  errorCases: 0,
  metricErrorCount: 0,
};

const runs = [
  {
    id: 'new',
    status: 'completed',
    createdAt: '2026-10-18T03:00:00Z',
    gitBranch: 'main',
    labels: { env: 'ci' },
    summary,
  },
  {
    id: 'old',
    status: 'completed',
    createdAt: '2026-10-18T01:00:00Z',
    gitBranch: 'main',
    labels: { env: 'local' },
    summary: { ...summary, passedCases: 2 },
  },
  {
    id: 'other',
    status: 'completed',
    createdAt: '2026-10-18T02:00:00Z',
    gitBranch: 'feature',
    labels: { env: 'ci' },
    summary,
  },
  { status: 'running', id: 'running', createdAt: '2026-10-18T06:00:00Z' },
  { status: 'completed', id: 'missing', createdAt: '2026-10-18T04:00:00Z', gitBranch: 'main' },
  {
    id: 'empty',
    status: 'completed',
    createdAt: '2026-10-18T05:00:00Z',
    summary: { ...summary, totalCases: 0, passedCases: 0 },
  },
] satisfies Parameters<typeof createRunTrends>[0];

it('groups branch trends chronologically and skips absent or empty summaries', () => {
  const trends = createRunTrends(runs, { kind: 'branch' });

  expect(trends.runningRuns).toBe(1);
  expect(trends.missingSummary).toBe(1);
  expect(trends.emptyRuns).toBe(1);
  expect(
    trends.groups.map(({ name, points }) => ({
      name,
      points: points.map(({ run, passRate }) => [run.id, passRate]),
    })),
  ).toEqual([
    { name: 'feature', points: [['other', 0.75]] },
    {
      name: 'main',
      points: [
        ['old', 0.5],
        ['new', 0.75],
      ],
    },
  ]);
});

it('groups label trends across branches without including missing summaries', () => {
  const trends = createRunTrends(runs, { kind: 'label', key: 'env' });

  expect(
    trends.groups.map(({ name, points }) => ({ name, runs: points.map(({ run }) => run.id) })),
  ).toEqual([
    { name: 'env=ci', runs: ['other', 'new'] },
    { name: 'env=local', runs: ['old'] },
  ]);
  expect(trends.runningRuns).toBe(1);
  expect(trends.missingSummary).toBe(1);
});

it('keeps a summarised run without the chosen label in the missing group', () => {
  const trends = createRunTrends(
    [
      {
        id: 'unlabelled',
        status: 'completed',
        createdAt: '2026-10-18T07:00:00Z',
        summary,
      },
    ],
    { kind: 'label', key: 'env' },
  );

  expect(
    trends.groups.map(({ name, points }) => ({
      name,
      runs: points.map(({ run }) => run.id),
    })),
  ).toEqual([{ name: 'env=(missing)', runs: ['unlabelled'] }]);
});
