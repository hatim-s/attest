import { describe, expect, it } from 'vitest';
import { prepareTrend, passRate, TREND_LIMIT, type TrendRun } from '../trend-model.js';
import { prepareActivity, ACTIVITY_LIMIT, type ActivityDay } from '../daily-model.js';

const complete = {
  id: 'a',
  label: 'a',
  startedAt: 100,
  runStatus: 'completed',
  state: 'complete',
  counts: { planned: 10, recorded: 10, passed: 8, failed: 2, errored: 0, skipped: 0, notRun: 0 },
} satisfies TrendRun;

const day = {
  day: '2026-11-06',
  runCount: 2,
  passed: 8,
  failed: 1,
  errored: 1,
  skipped: 2,
} satisfies ActivityDay;

describe('eval slice trend', () => {
  it('plots a complete eval B when eval A caused the overall run to fail', () => {
    const evalB = { ...complete, runStatus: 'failed' } satisfies TrendRun;

    const evalA = {
      ...evalB,
      state: 'incomplete',
      counts: { ...complete.counts, passed: 7, errored: 1 },
    } satisfies TrendRun;

    expect(passRate(evalB)).toBe(0.8);
    expect(passRate(evalA)).toBeNull();
    expect(prepareTrend([evalB], 'run')[0]?.rate).toBe(0.8);
  });

  it('keeps running/incomplete slices and zero denominators off the line', () => {
    expect(passRate({ ...complete, state: 'running' })).toBeNull();
    expect(passRate({ ...complete, state: 'incomplete', runStatus: 'cancelled' })).toBeNull();
    expect(
      passRate({ ...complete, counts: { ...complete.counts, recorded: 0, passed: 0 } }),
    ).toBeNull();
  });

  it('preserves unknown plans and compares recorded rates without claiming case regressions', () => {
    const smaller = {
      ...complete,
      id: 'b',
      startedAt: 200,
      counts: { ...complete.counts, planned: null, notRun: null, recorded: 5, passed: 3 },
    } satisfies TrendRun;

    const points = prepareTrend(
      [smaller, { ...complete, id: 'rail', startedAt: 150, state: 'incomplete' }, complete],
      'run',
    );

    expect(points.map((point) => point.run.id)).toEqual(['a', 'rail', 'b']);
    expect(points[2]?.rate).toBe(0.6);
    expect(points[2]?.comparison?.previousId).toBe('a');
    expect(points[2]?.comparison?.points).toBeCloseTo(-20);
    expect(points[2]?.comparison?.selectionChanged).toBe(true);
    expect(points[2]?.run.counts.notRun).toBeNull();
  });

  it('orders timestamp ties by identity and places singleton and date points deterministically', () => {
    expect(prepareTrend([], 'date')).toEqual([]);
    expect(prepareTrend([complete], 'run')[0]?.x).toBe(0.5);
    expect(prepareTrend([complete, { ...complete, id: 'z' }], 'date').map(({ x }) => x)).toEqual([
      0.5, 0.5,
    ]);
    expect(
      prepareTrend([{ ...complete, id: 'z' }, complete], 'date').map(({ run }) => run.id),
    ).toEqual(['a', 'z']);
    expect(
      prepareTrend(
        [
          { ...complete, id: 'b', startedAt: 200 },
          complete,
          { ...complete, id: 'c', startedAt: 500 },
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
    const activity = prepareActivity([
      day,
      { ...day, day: '2026-11-05', passed: 2, failed: 3, errored: 2, skipped: 20 },
    ]);

    expect(activity.ordered.map(({ day }) => day)).toEqual(['2026-11-05', '2026-11-06']);
    expect(activity.up).toBe(8);
    expect(activity.down).toBe(5);
    expect(activity.totals).toEqual({
      runCount: 4,
      passed: 10,
      failed: 4,
      errored: 3,
      skipped: 22,
    });
  });

  it('supports empty/single windows and enforces a bounded summary input', () => {
    expect(prepareActivity([]).totals.runCount).toBe(0);
    expect(prepareActivity([day]).ordered).toEqual([day]);
    expect(() => prepareActivity(Array.from({ length: ACTIVITY_LIMIT + 1 }, () => day))).toThrow(
      'Activity window exceeds 92 days',
    );
  });
});
