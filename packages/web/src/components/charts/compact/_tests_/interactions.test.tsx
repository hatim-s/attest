// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DailyActivity } from '../daily-activity.js';
import { PassRateTrend } from '../pass-rate-trend.js';
import type { TrendRun } from '../trend-model.js';

const counts = {
  planned: 10,
  recorded: 10,
  passed: 8,
  failed: 2,
  errored: 0,
  skipped: 0,
  notRun: 0,
};

const run = (id: string, startedAt: number): TrendRun => ({
  id,
  label: id,
  startedAt,
  state: 'complete',
  passRate: 0.8,
  runStatus: 'failed',
  counts,
});

const a = run('a', 100),
  b = run('b', 200),
  c = run('c', 300);

const container = document.createElement('div');

let resize: () => void;

const disconnect = vi.fn();

vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe() {}
    disconnect = disconnect;
  },
);

/** Flush React work before inspecting focus and updated props. */
async function settle(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({ width: 375 }),
  );
});

const root = () => {
  document.body.append(container);

  return createRoot(container);
};

afterEach(() => {
  container.replaceChildren();
  container.remove();
  vi.restoreAllMocks();
});

it('resolves stale hover and focus separately, keeps selection, and disconnects resize observation', async () => {
  const mounted = root();
  let width = 700;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({ width }),
  );

  const render = (runs: readonly TrendRun[]) => (
    <PassRateTrend
      runs={runs}
      axis="run"
      utcOffsetMinutes={330}
      onAxisChange={() => {}}
      runHref={({ id }) => `#${id}`}
      selectedRunId="b"
      label="Trend"
    />
  );

  await settle(() => mounted.render(render([a, b, c])));
  const mark = container.querySelector('svg a');
  await settle(() => mark?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('Run a,');
  await settle(() => mounted.render(render([b, c])));
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('Run b,');
  expect(container.querySelector('.attest-chart-selection')).not.toBeNull();
  width = 375;
  await settle(() => resize());
  expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 375 230');
  await settle(() => mounted.unmount());
  expect(disconnect).toHaveBeenCalled();
});

it('offers every dense identity including rail slices with real links at unchanged timestamps', async () => {
  const mounted = root();

  const runs = Array.from({ length: 200 }, (_, index): TrendRun =>
    index % 2
      ? run(String(index), 100)
      : {
          id: String(index),
          label: String(index),
          startedAt: 100,
          state: 'incomplete',
          runStatus: 'completed',
          counts,
        },
  );

  await settle(() =>
    mounted.render(
      <PassRateTrend
        runs={runs}
        axis="date"
        utcOffsetMinutes={0}
        onAxisChange={() => {}}
        runHref={({ id }) => `#run/${id}`}
        selectedRunId="0"
        label="Dense"
      />,
    ),
  );
  expect(container.querySelectorAll('option')).toHaveLength(200);
  expect(container.querySelectorAll('svg a')).toHaveLength(0);
  const select = container.querySelector('select')!;
  await settle(() => {
    select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('.attest-chart-chooser a')?.getAttribute('href')).toBe('#run/1');
  expect(container.querySelector('.rail-incomplete')).not.toBeNull();
  expect(container.querySelector('.attest-chart-selection')).not.toBeNull();
  await settle(() => mounted.unmount());
});

it('daily hover beats clicked focus, stale props resolve selection, zero days are inert, and tiny failures remain visible', async () => {
  const mounted = root();
  const onSelectDay = vi.fn();

  const day = (day: string) => ({
    day,
    runCount: 1,
    passed: 1000,
    failed: 1,
    errored: 0,
    skipped: 0,
  });

  const window = { from: '2026-11-01', to: '2026-11-04', utcOffsetMinutes: 330 };

  const render = (days: ReturnType<typeof day>[]) => (
    <DailyActivity days={days} window={window} selectedDay="2026-11-02" onSelectDay={onSelectDay} />
  );

  await settle(() =>
    mounted.render(render([day('2026-11-01'), day('2026-11-02'), day('2026-11-03')])),
  );
  const marks = container.querySelectorAll<SVGElement>('[data-chart-mark]');
  await settle(() => {
    marks[1]?.focus();
    marks[0]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('2026-11-01');
  await settle(() => mounted.render(render([day('2026-11-02'), day('2026-11-03')])));
  // The still-present zero bucket is a valid hover. Removing its calendar window invalidates it.
  await settle(() =>
    mounted.render(
      <DailyActivity
        days={[day('2026-11-02'), day('2026-11-03')]}
        window={{ ...window, from: '2026-11-02' }}
        selectedDay="2026-11-02"
        onSelectDay={onSelectDay}
      />,
    ),
  );
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('2026-11-02');
  expect(container.querySelectorAll('[data-chart-mark]')).toHaveLength(2);
  expect(container.querySelector('.attest-chart-bar-fail')?.getAttribute('height')).toBe('2');
  expect(container.querySelector('.attest-chart-selection')).not.toBeNull();
  await settle(() => mounted.unmount());
});
