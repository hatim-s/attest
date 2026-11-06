// @vitest-environment happy-dom
import { act, useState } from 'react';
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
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('Run a');
  await settle(() => mounted.render(render([b, c])));
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('Run b');
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
  expect(container.querySelectorAll('svg a[tabindex="-1"]')).toHaveLength(200);
  expect(container.querySelectorAll('option')[1]?.textContent).toContain('1970-01-01 00:00:00.100');
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

it('dense 28-day slots at 500px retain pointer selection and a chooser with exact counts', async () => {
  const mounted = root();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({ width: 500, height: 220 }),
  );
  const onSelectDay = vi.fn();

  const days = Array.from({ length: 28 }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, '0')}`,
    runCount: 1,
    passed: i + 1,
    failed: 0,
    errored: 0,
    skipped: 0,
  }));

  await settle(() =>
    mounted.render(
      <DailyActivity
        days={days}
        window={{ from: '2026-11-01', to: '2026-11-28', utcOffsetMinutes: 0 }}
        onSelectDay={onSelectDay}
      />,
    ),
  );
  const svg = container.querySelector('svg')!;

  const spy = vi
    .spyOn(svg, 'getBoundingClientRect')
    .mockReturnValue(DOMRect.fromRect({ width: 500, height: 220 }));

  const pointer = { bubbles: true, clientX: 44 + ((478 - 44) / 28) * 7.5, clientY: 100 };
  await settle(() => svg.dispatchEvent(new MouseEvent('mousemove', pointer)));
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('2026-11-08');
  expect(
    container.querySelector('.attest-chart-actions button')?.getAttribute('aria-disabled'),
  ).toBe('true');
  await settle(() => svg.dispatchEvent(new MouseEvent('click', pointer)));
  expect(onSelectDay).toHaveBeenCalledWith('2026-11-08');
  expect(container.querySelectorAll('option')).toHaveLength(29);
  expect(container.querySelectorAll('[data-chart-mark]')).toHaveLength(0);
  spy.mockRestore();
  await settle(() => mounted.unmount());
});

it('dense 30-run nearest-point hover works and inspection ends on controlled change or outside focus', async () => {
  const mounted = root();
  const runs = Array.from({ length: 30 }, (_, i) => run(`id${i}`, i * 1000));

  const render = (selectedRunId: string) => (
    <PassRateTrend
      runs={runs}
      axis="date"
      utcOffsetMinutes={0}
      onAxisChange={() => {}}
      runHref={({ id }) => `#${id}`}
      selectedRunId={selectedRunId}
      label="Trend"
    />
  );

  await settle(() => mounted.render(render('id0')));
  const svg = container.querySelector('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ width: 375, height: 230 }),
  );
  const hotspot = container.querySelector('svg a[href="#id12"]')!;
  const first = container.querySelector<SVGElement>('svg a[href="#id0"]')!;
  await settle(() => first.focus());
  await settle(() => hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain('Run id12');
  expect(hotspot.getAttribute('href')).toBe('#id12');
  await settle(() => hotspot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  expect(container.querySelectorAll('svg a')).toHaveLength(runs.length);
  expect(hotspot.querySelector('.attest-chart-hit')?.getAttribute('d')).toMatch(/^M/);
  expect(container.querySelector('svg a[href="#id12"]')).toBe(hotspot);
  await settle(() => svg.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  const select = container.querySelector('select')!;
  await settle(() => {
    select.focus();
    select.value = 'id4';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const action = container.querySelector<HTMLAnchorElement>('.attest-chart-chooser a')!;
  await settle(() => action.focus());
  expect(action.getAttribute('href')).toBe('#id4');
  await settle(() => mounted.render(render('id8')));
  expect(action.getAttribute('href')).toBe('#id8');
  await settle(() => {
    select.focus();
    select.value = 'id5';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(() => select.blur());
  expect(action.getAttribute('href')).toBe('#id8');
  await settle(() => mounted.unmount());
});

it('daily inspection survives movement to its action and clears on selection and window updates', async () => {
  const mounted = root();

  const days = [
    { day: '2026-11-01', runCount: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
    { day: '2026-11-02', runCount: 1, passed: 2, failed: 0, errored: 0, skipped: 0 },
  ];

  const render = (selectedDay?: string, from = '2026-11-01') => (
    <DailyActivity
      days={days.filter((day) => day.day >= from)}
      window={{ from, to: '2026-11-28', utcOffsetMinutes: 0 }}
      selectedDay={selectedDay}
      onSelectDay={() => {}}
    />
  );

  await settle(() => mounted.render(render()));
  const select = container.querySelector('select')!;
  await settle(() => {
    select.focus();
    select.value = '2026-11-01';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(() =>
    container.querySelector<HTMLButtonElement>('.attest-chart-actions button')?.focus(),
  );
  expect(container.querySelector('.attest-chart-actions button')?.textContent).toContain(
    '2026-11-01',
  );
  await settle(() => mounted.render(render('2026-11-02')));
  expect(container.querySelector('.attest-chart-actions button')?.textContent).toContain(
    '2026-11-02',
  );
  await settle(() => {
    select.focus();
    select.value = '2026-11-01';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.blur();
  });
  expect(container.querySelector('.attest-chart-actions button')?.textContent).toContain(
    '2026-11-02',
  );
  await settle(() => mounted.render(render(undefined, '2026-11-02')));
  expect(
    container.querySelector('.attest-chart-actions button')?.getAttribute('aria-disabled'),
  ).toBe('true');
  await settle(() => mounted.unmount());
});

it('updates equal daily maxima across mounted frames without duplicate keys or stale ticks, including empty windows', async () => {
  const mounted = root();
  const errors = vi.spyOn(console, 'error');

  const render = (passed: number, failed: number) => (
    <DailyActivity
      days={[
        {
          day: '2026-11-01',
          runCount: passed + failed > 0 ? 1 : 0,
          passed,
          failed,
          errored: 0,
          skipped: 0,
        },
      ]}
      window={{ from: '2026-11-01', to: '2026-11-01', utcOffsetMinutes: 0 }}
      onSelectDay={() => {}}
    />
  );

  const ticks = () =>
    Array.from(container.querySelectorAll('svg > g[aria-hidden] text'), (tick) => tick.textContent);

  await settle(() => mounted.render(render(8, 8)));
  expect(ticks()).toEqual(['8', '0', '8']);
  await settle(() => mounted.render(render(5, 7)));
  expect(ticks()).toEqual(['5', '0', '7']);
  await settle(() => mounted.render(render(3, 4)));
  expect(ticks()).toEqual(['3', '0', '4']);
  await settle(() => mounted.render(render(0, 0)));
  expect(ticks()).toEqual(['0']);
  expect(container.querySelector('svg')?.textContent).toContain('No activity in this window');
  expect(errors).not.toHaveBeenCalled();
  await settle(() => mounted.unmount());
});

it('keeps a focused run action and chooser fixed across hover and appended polling data', async () => {
  const mounted = root();

  const render = (runs: TrendRun[]) => (
    <PassRateTrend
      runs={runs}
      axis="run"
      utcOffsetMinutes={0}
      onAxisChange={() => {}}
      runHref={({ id }) => `#${id}`}
      label="Trend"
    />
  );

  await settle(() => mounted.render(render([a, b, c])));
  const select = container.querySelector('select')!;
  await settle(() => {
    select.focus();
    select.value = 'a';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const action = container.querySelector<HTMLAnchorElement>('.attest-chart-chooser a')!;
  await settle(() => action.focus());
  await settle(() => mounted.render(render([a, b, c, run('d', 400)])));
  expect(document.activeElement).toBe(action);
  expect(action.getAttribute('href')).toBe('#a');
  await settle(() =>
    container
      .querySelectorAll('svg a')[2]
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  );
  expect(action.getAttribute('href')).toBe('#a');
  expect(select.value).toBe('a');
  await settle(() => mounted.unmount());
});

it('pins a default action on focus and expires inspection on removal, departure, axis or offset changes', async () => {
  const mounted = root();

  const render = (runs: TrendRun[], axis: 'run' | 'date' = 'run', offset = 0) => (
    <PassRateTrend
      runs={runs}
      axis={axis}
      utcOffsetMinutes={offset}
      onAxisChange={() => {}}
      runHref={({ id }) => `#${id}`}
      label="Trend"
    />
  );

  await settle(() => mounted.render(render([a, b])));
  const action = container.querySelector<HTMLAnchorElement>('.attest-chart-action')!;
  await settle(() => action.focus());
  await settle(() => mounted.render(render([a, b, c])));
  expect(action.getAttribute('href')).toBe('#b');
  await settle(() => action.blur());
  expect(action.getAttribute('href')).toBe('#c');
  const select = container.querySelector('select')!;

  const inspectA = async () =>
    settle(() => {
      select.focus();
      select.value = 'a';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

  await inspectA();
  await settle(() => mounted.render(render([b, c])));
  await settle(() => mounted.render(render([a, b, c])));
  expect(action.getAttribute('href')).toBe('#c');
  await inspectA();
  await settle(() => mounted.render(render([a, b, c], 'date')));
  expect(action.getAttribute('href')).toBe('#c');
  await inspectA();
  await settle(() => mounted.render(render([a, b, c], 'date', 330)));
  expect(action.getAttribute('href')).toBe('#c');
  await settle(() => mounted.unmount());
});

it('pins the displayed default when the chooser receives focus without a value change', async () => {
  const mounted = root();

  const render = (runs: TrendRun[]) => (
    <PassRateTrend
      runs={runs}
      axis="run"
      utcOffsetMinutes={0}
      onAxisChange={() => {}}
      runHref={({ id }) => `#${id}`}
      label="Trend"
    />
  );

  await settle(() => mounted.render(render([a, b, c])));
  const select = container.querySelector('select')!;
  await settle(() => select.focus());
  await settle(() => mounted.render(render([a, b, c, run('d', 400)])));
  expect(select.value).toBe('c');
  expect(container.querySelector('.attest-chart-action')?.getAttribute('href')).toBe('#c');
  await settle(() => mounted.unmount());
});

it('commits daily selection once across real controlled updates and retains action focus', async () => {
  const mounted = root();
  const selected = vi.fn();

  function Host() {
    const [selectedDay, setSelectedDay] = useState<string>();

    return (
      <DailyActivity
        days={[{ day: '2026-11-01', runCount: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }]}
        window={{ from: '2026-11-01', to: '2026-11-28', utcOffsetMinutes: 0 }}
        selectedDay={selectedDay}
        onSelectDay={(day) => {
          selected(day);
          setSelectedDay(day);
        }}
      />
    );
  }

  await settle(() => mounted.render(<Host />));
  const select = container.querySelector('select')!;
  await settle(() => {
    select.focus();
    select.value = '2026-11-01';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const action = container.querySelector<HTMLButtonElement>('.attest-chart-action')!;
  await settle(() => action.focus());
  await settle(() => action.click());
  expect(action.disabled).toBe(false);
  expect(action.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(action);
  await settle(() => action.click());
  const svg = container.querySelector('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ width: 375, height: 220 }),
  );
  await settle(() =>
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 49, clientY: 100 })),
  );
  expect(selected).toHaveBeenCalledTimes(1);
  await settle(() => mounted.unmount());
});

it('sparse daily click, Enter and Space do not repeat controlled selection', async () => {
  const mounted = root();
  const selected = vi.fn();

  function Host() {
    const [selectedDay, setSelectedDay] = useState<string>();

    return (
      <DailyActivity
        days={[{ day: '2026-11-01', runCount: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }]}
        window={{ from: '2026-11-01', to: '2026-11-02', utcOffsetMinutes: 0 }}
        selectedDay={selectedDay}
        onSelectDay={(day) => {
          selected(day);
          setSelectedDay(day);
        }}
      />
    );
  }

  await settle(() => mounted.render(<Host />));
  const mark = container.querySelector('[data-chart-mark]')!;
  await settle(() => mark.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  for (const key of ['Enter', ' '])
    await settle(() => mark.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
  await settle(() => mark.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(selected).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.attest-chart-actions')).toBeNull();
  await settle(() => mounted.unmount());
});

it('transfers owned sparse focus into the dense chooser on resize without stealing external focus', async () => {
  const mounted = root();
  let width = 1000;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({ width }),
  );
  const runs = Array.from({ length: 30 }, (_, i) => run(`id${i}`, i * 1000));
  await settle(() =>
    mounted.render(
      <PassRateTrend
        runs={runs}
        axis="run"
        utcOffsetMinutes={0}
        onAxisChange={() => {}}
        runHref={({ id }) => `#${id}`}
        label="Trend"
      />,
    ),
  );
  const mark = container.querySelector<SVGElement>('[data-chart-mark]')!;
  await settle(() => mark.focus());
  width = 375;
  await settle(() => resize());
  expect(document.activeElement).toBe(container.querySelector('select'));
  expect(container.querySelector('svg a')).toBe(mark);
  const external = document.createElement('button');
  document.body.append(external);
  await settle(() => external.focus());
  width = 1000;
  await settle(() => resize());
  width = 375;
  await settle(() => resize());
  expect(document.activeElement).toBe(external);
  external.remove();
  await settle(() => mounted.unmount());
});

it('dense nonmouse taps use bounded day identity without mousemove and reject drags', async () => {
  const mounted = root();
  const selected = vi.fn();
  await settle(() =>
    mounted.render(
      <DailyActivity
        days={[{ day: '2026-11-01', runCount: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }]}
        window={{ from: '2026-11-01', to: '2026-11-28', utcOffsetMinutes: 0 }}
        onSelectDay={selected}
      />,
    ),
  );
  const svg = container.querySelector('svg')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ width: 375, height: 220 }),
  );

  const pointer = async (type: string, x: number, y: number, pointerType = 'touch') =>
    settle(() =>
      svg.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType,
        }),
      ),
    );

  await pointer('pointerdown', 49, 100);
  await pointer('pointerup', 49, 100);
  expect(selected).toHaveBeenCalledExactlyOnceWith('2026-11-01');
  await settle(() =>
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 49, clientY: 100 })),
  );
  expect(selected).toHaveBeenCalledTimes(1);
  await pointer('pointerdown', 49, 100, 'pen');
  await pointer('pointermove', 90, 100, 'pen');
  await pointer('pointerup', 49, 100, 'pen');
  expect(selected).toHaveBeenCalledTimes(1);
  await pointer('pointerdown', 49, 215);
  await pointer('pointerup', 49, 215);
  expect(selected).toHaveBeenCalledTimes(1);
  await pointer('pointerdown', 49, 100, 'pen');
  await pointer('pointerup', 49, 100, 'pen');
  expect(selected).toHaveBeenCalledTimes(2);
  await settle(() => mounted.unmount());
});

it('moves focus to the staged trend action before pointer activation without changing its destination', async () => {
  const mounted = root();
  await settle(() =>
    mounted.render(
      <PassRateTrend
        runs={[a, b, c]}
        axis="run"
        utcOffsetMinutes={0}
        onAxisChange={() => {}}
        runHref={({ id }) => `#${id}`}
        label="Trend"
      />,
    ),
  );
  const select = container.querySelector('select')!;
  await settle(() => {
    select.focus();
    select.value = 'a';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const action = container.querySelector<HTMLAnchorElement>('.attest-chart-action')!;

  const down = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerType: 'touch',
  });

  await settle(() => action.dispatchEvent(down));
  // Cancellation prevents the browser's click-focus default from blurring the chooser to body.
  expect(down.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(action);
  expect(action.getAttribute('href')).toBe('#a');
  await settle(() => action.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(action.getAttribute('href')).toBe('#a');
  await settle(() => action.blur());
  expect(action.getAttribute('href')).toBe('#c');
  await settle(() => mounted.unmount());
});

it('commits the inspected day without relying on browser click-focus behavior', async () => {
  const mounted = root();
  const selected = vi.fn();
  await settle(() =>
    mounted.render(
      <DailyActivity
        days={[{ day: '2026-11-01', runCount: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }]}
        window={{ from: '2026-11-01', to: '2026-11-28', utcOffsetMinutes: 0 }}
        onSelectDay={selected}
      />,
    ),
  );
  const select = container.querySelector('select')!;
  await settle(() => {
    select.focus();
    select.value = '2026-11-01';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const action = container.querySelector<HTMLButtonElement>('.attest-chart-action')!;
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  await settle(() => action.dispatchEvent(down));
  expect(down.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(action);
  await settle(() => action.click());
  expect(selected).toHaveBeenCalledExactlyOnceWith('2026-11-01');
  await settle(() => mounted.unmount());
});

it.each(['chooser', 'action'])(
  'returns owned daily %s focus to the inspected mark when density decreases',
  async (owner) => {
    const mounted = root();
    let width = 375;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ width }),
    );
    await settle(() =>
      mounted.render(
        <DailyActivity
          days={[
            { day: '2026-11-01', runCount: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
            { day: '2026-11-02', runCount: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
          ]}
          window={{ from: '2026-11-01', to: '2026-11-28', utcOffsetMinutes: 0 }}
          onSelectDay={() => {}}
        />,
      ),
    );
    const select = container.querySelector('select')!;
    await settle(() => {
      select.focus();
      select.value = '2026-11-02';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    if (owner === 'action')
      await settle(() =>
        container.querySelector<HTMLButtonElement>('.attest-chart-action')!.focus(),
      );
    width = 1000;
    await settle(() => resize());
    expect(document.activeElement?.getAttribute('aria-label')).toContain('2026-11-02');
    expect(document.activeElement?.hasAttribute('data-chart-mark')).toBe(true);
    width = 375;
    await settle(() => resize());
    expect(document.activeElement).toBe(container.querySelector('select'));
    const external = document.createElement('button');
    document.body.append(external);
    await settle(() => external.focus());
    width = 1000;
    await settle(() => resize());
    expect(document.activeElement).toBe(external);
    external.remove();
    await settle(() => mounted.unmount());
  },
);

it('explains the missing current rate without denying an earlier complete slice', async () => {
  const mounted = root();

  const incomplete: TrendRun = {
    id: 'pending',
    startedAt: 400,
    state: 'running',
    runStatus: 'running',
    counts,
  };

  await settle(() =>
    mounted.render(
      <PassRateTrend
        runs={[a, incomplete]}
        selectedRunId="pending"
        axis="run"
        utcOffsetMinutes={0}
        onAxisChange={() => {}}
        runHref={({ id }) => `#${id}`}
        label="Trend"
      />,
    ),
  );
  expect(container.querySelector('.attest-chart-readout')?.textContent).toContain(
    'No pass rate for this slice',
  );
  expect(container.querySelector('.attest-chart-readout')?.textContent).not.toContain(
    'No earlier complete slice',
  );
  await settle(() => mounted.unmount());
});
