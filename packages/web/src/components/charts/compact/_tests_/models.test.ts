import type { EvalSlice } from '@attest/core/records';
import { nativeHitRegions } from '../chart-layout.js';
import { describe, expect, it } from 'vitest';
import { prepareTrend, TREND_LIMIT } from '../trend-model.js';
import {
  prepareActivity,
  activityWindow,
  ACTIVITY_LIMIT,
  type ActivityDay,
} from '../daily-model.js';

const counts = {
  planned: 10,
  recorded: 10,
  passed: 8,
  failed: 2,
  errored: 0,
  skipped: 0,
  metricErrors: 0,
  scored: 0,
  scoreSum: 0,
  notRun: 0,
};

const at = (ms: number) => new Date(ms).toISOString();

const complete = {
  runId: 'a',
  suiteName: 'smoke',
  createdAt: at(100),
  finishedAt: null,
  runStatus: 'completed',
  gitBranch: null,
  gitSha: null,
  counts,
  meanScore: null,
  state: 'complete',
  passRate: 0.8,
} satisfies EvalSlice;

/** A slice with no pass rate, as the store reports a running or incomplete eval. */
const rail = (runId: string, state: 'running' | 'incomplete', createdAt: string): EvalSlice => ({
  ...complete,
  runId,
  createdAt,
  state,
  passRate: null,
  runStatus: state === 'running' ? 'running' : 'cancelled',
});

const window = { from: '2026-11-05', to: '2026-11-06' };

const day = {
  day: '2026-11-06',
  slices: 2,
  passed: 8,
  failed: 1,
  errored: 1,
  skipped: 2,
} satisfies ActivityDay;

describe('eval slice trend', () => {
  it('puts complete slices on the line and every other slice on the rail', () => {
    // A complete eval slice keeps its rate even when another eval failed the enclosing run.
    const failedRun = { ...complete, runStatus: 'failed' } satisfies EvalSlice;

    const points = prepareTrend(
      [failedRun, rail('r', 'running', at(300)), rail('c', 'incomplete', at(200))],
      'run',
    );

    expect(points.map(({ run, rate }) => [run.runId, rate])).toEqual([
      ['a', 0.8],
      ['c', null],
      ['r', null],
    ]);
    expect(points.map(({ comparison }) => comparison)).toEqual([null, null, null]);
  });

  it('preserves unknown plans and compares recorded rates without claiming case regressions', () => {
    const smaller = {
      ...complete,
      runId: 'b',
      passRate: 0.6,
      createdAt: at(200),
      counts: { ...counts, planned: null, notRun: null, recorded: 5, passed: 3 },
    } satisfies EvalSlice;

    const points = prepareTrend([smaller, rail('rail', 'incomplete', at(150)), complete], 'run');

    expect(points.map((point) => point.run.runId)).toEqual(['a', 'rail', 'b']);
    expect(points[2]?.rate).toBe(0.6);
    expect(points[2]?.comparison?.previousId).toBe('a');
    expect(points[2]?.comparison?.points).toBeCloseTo(-20);
    expect(points[2]?.comparison?.selectionChanged).toBe(true);
    expect(points[2]?.run.counts.notRun).toBeNull();
  });

  it('orders timestamp ties by identity and places singleton and date points deterministically', () => {
    expect(prepareTrend([], 'date')).toEqual([]);
    expect(prepareTrend([complete], 'run')[0]?.x).toBe(0.5);
    expect(prepareTrend([complete, { ...complete, runId: 'z' }], 'date').map(({ x }) => x)).toEqual(
      [0.5, 0.5],
    );
    expect(
      prepareTrend([{ ...complete, runId: 'z' }, complete], 'date').map(({ run }) => run.runId),
    ).toEqual(['a', 'z']);
    expect(
      prepareTrend(
        [
          { ...complete, runId: 'b', createdAt: at(200) },
          complete,
          { ...complete, runId: 'c', createdAt: at(500) },
        ],
        'date',
      ).map(({ x }) => x),
    ).toEqual([0, 0.25, 1]);
    expect(() =>
      prepareTrend(
        Array.from({ length: TREND_LIMIT + 1 }, () => complete),
        'run',
      ),
    ).toThrow('Trend window exceeds 200 slices');
  });
});

describe('daily activity', () => {
  it('orders days and keeps skipped counts separate from the shared diverging scale', () => {
    const activity = prepareActivity(
      [day, { ...day, day: '2026-11-05', passed: 2, failed: 3, errored: 2, skipped: 20 }],
      window,
    );

    expect(activity.ordered.map(({ day }) => day)).toEqual(['2026-11-05', '2026-11-06']);
    expect(activity.up).toBe(8);
    expect(activity.down).toBe(5);
    expect(activity.totals).toEqual({
      slices: 4,
      passed: 10,
      failed: 4,
      errored: 3,
      skipped: 22,
    });
  });

  it('supports empty/single windows and enforces a bounded summary input', () => {
    expect(prepareActivity([], window).totals.slices).toBe(0);
    expect(prepareActivity([day], { ...window, from: day.day }).ordered).toEqual([day]);
    expect(() =>
      prepareActivity(
        Array.from({ length: ACTIVITY_LIMIT + 1 }, () => day),
        window,
      ),
    ).toThrow('Activity window exceeds 92 days');
  });
});

it('fills sparse UTC calendar gaps and bounds inclusive buckets', () => {
  const filled = prepareActivity([day], { from: '2026-11-04', to: '2026-11-06' });

  expect(filled.ordered.map(({ day, slices }) => [day, slices])).toEqual([
    ['2026-11-04', 0],
    ['2026-11-05', 0],
    ['2026-11-06', 2],
  ]);
  expect(prepareActivity([], { from: '2026-01-01', to: '2026-04-02' }).ordered).toHaveLength(92);

  for (const to of ['2026-04-03', 'invalid', '2025-12-31', '2026-02-30'])
    expect(() => prepareActivity([], { from: '2026-01-01', to })).toThrow(RangeError);
});

it('charts only the UTC days an activity read covers', () => {
  expect(
    activityWindow({
      coveredFrom: '2026-10-26T00:00:00.000Z',
      coveredTo: '2026-11-09T00:00:00.000Z',
    }),
  ).toEqual({ from: '2026-10-26', to: '2026-11-08' });
  // A fully truncated read covers nothing, so there is no window to draw.
  expect(
    activityWindow({
      coveredFrom: '2026-11-09T00:00:00.000Z',
      coveredTo: '2026-11-09T00:00:00.000Z',
    }),
  ).toBeNull();
});

it('partitions native hit regions by nearest identity within bounded mark squares', () => {
  const centers = [
    { x: 44, y: 78 },
    { x: 54, y: 78 },
    { x: 54, y: 88 },
    { x: 54, y: 88 },
    { x: 353, y: 198 },
  ];

  const regions = nativeHitRegions(centers);
  expect(regions[3]).toBe('');

  for (const [i, path] of regions.entries()) {
    if (i === 3) continue;
    const center = centers[i]!;
    const vertices = [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)];
    expect(vertices.length).toBeGreaterThanOrEqual(3);

    for (const vertex of vertices) {
      const x = Number(vertex[1]),
        y = Number(vertex[2]);

      expect(Math.abs(x - center.x)).toBeLessThanOrEqual(24);
      expect(Math.abs(y - center.y)).toBeLessThanOrEqual(24);

      for (const other of centers)
        expect(Math.hypot(x - center.x, y - center.y)).toBeLessThanOrEqual(
          Math.hypot(x - other.x, y - other.y) + 1e-9,
        );
    }
  }
});
