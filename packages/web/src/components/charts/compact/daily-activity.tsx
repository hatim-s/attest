import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { moveChartFocus } from './chart-keyboard.js';
import { prepareActivity, type ActivityDay, type ActivityWindow } from './daily-model.js';
import {
  useChartWidth,
  focusChartAction,
  useDenseFocus,
  resolveActive,
  timezoneLabel,
  useInspection,
  plotPointer,
} from './chart-layout.js';
import './compact-charts.css';

type DailyActivityProps = {
  /** Sparse daily aggregates in the declared calendar window, at most 92 buckets. */
  days: readonly ActivityDay[];
  window: ActivityWindow;
  selectedDay?: string;
  onSelectDay: (day: string) => void;
  label?: string;
};

/** Hosts key this component by project/source/calendar-window/filter context.
 * Selecting a real calendar day lets the caller load its bounded run list.
 * The chooser stages a day; Select day commits it through onSelectDay. */
function DailyActivity({
  days,
  window,
  selectedDay,
  onSelectDay,
  label = 'Cases per day',
}: DailyActivityProps) {
  const { ordered, up, down, totals } = useMemo(
    () => prepareActivity(days, window),
    [days, window],
  );

  // Keep compatibility clicks from activating the same touch/pen gesture twice.
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    nonmouse: boolean;
    moved: boolean;
  } | null>(null);

  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const inspection = useInspection(
    selectedDay,
    `${label}:${window.from}:${window.to}:${window.utcOffsetMinutes}`,
    ordered.filter((day) => day.runCount > 0).map((day) => day.day),
  );

  const { ref, width: chartWidth } = useChartWidth();

  const active = resolveActive(ordered, (day) => day.day, [
    hovered,
    focused,
    inspection.id,
    selectedDay,
  ]);

  const right = Math.max(68, chartWidth - 22);
  const counts = active ?? totals;
  const scale = 160 / Math.max(1, up + down);
  const zero = up + down === 0 ? 98 : 18 + up * scale;
  const slot = (right - 44) / Math.max(1, ordered.length);
  const width = Math.min(14, slot * 0.6);

  const dense = slot < 24;
  useDenseFocus(dense, ref);

  /** One guard owns every activation path, including controlled host updates. */
  const selectDay = (day: ActivityDay) => {
    if (day.runCount > 0 && day.day !== selectedDay) onSelectDay(day.day);
  };

  const actionDay = resolveActive(ordered, (day) => day.day, [inspection.id, selectedDay]);
  const departingActions = useRef(false);

  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;

    // React detaches this ref before removing the chooser, while its focused child still exists.
    return () => {
      departingActions.current = node.contains(document.activeElement);
    };
  }, []);

  useLayoutEffect(() => {
    if (!dense && departingActions.current && document.activeElement === document.body) {
      const marks = Array.from(
        ref.current?.querySelectorAll<SVGElement>('[data-chart-mark]') ?? [],
      );

      const target = marks.find((mark) => mark.dataset.day === actionDay?.day) ?? marks[0];
      target?.focus({ preventScroll: true });
    }

    departingActions.current = false;
  }, [dense, actionDay, ref]);

  const nearest = (event: MouseEvent<SVGSVGElement>) => {
    const pointer = plotPointer(event, chartWidth, 220);

    if (pointer.x < 44 || pointer.x >= right || pointer.y < 10 || pointer.y > 190) return undefined;

    return ordered[Math.floor((pointer.x - 44) / slot)];
  };

  const dayLabel = `${active?.day ?? 'Window total'}, ${counts.runCount} ${counts.runCount === 1 ? 'run' : 'runs'}. ${timezoneLabel(window.utcOffsetMinutes)}.`;
  const countLabel = `${counts.passed} passed, ${counts.failed} failed, ${counts.errored} errored, ${counts.skipped} skipped. Skipped cases are excluded from bars.`;

  return (
    <section ref={ref} className="attest-compact-chart" aria-label={label}>
      <h3>{label}</h3>
      <div className="attest-chart-readout">
        <strong>
          {counts.passed + counts.failed + counts.errored}{' '}
          {counts.passed + counts.failed + counts.errored === 1 ? 'case' : 'cases'} ran
        </strong>
        <span title={dayLabel}>{dayLabel}</span>
        <span title={countLabel}>{countLabel}</span>
      </div>
      {dense && (
        <div ref={actionsRef} className="attest-chart-actions" onBlur={inspection.onBlur}>
          <label className="attest-chart-chooser">
            Inspect day{' '}
            <select
              value={actionDay?.day ?? ''}
              onFocus={() => {
                const next =
                  ordered.find((day) => day.day === focused && day.runCount > 0) ?? actionDay;

                if (next) inspection.inspect(next.day);
              }}
              onChange={(event) => {
                setHovered(null);
                inspection.inspect(event.target.value);
              }}
            >
              <option value="" disabled>
                Choose a day
              </option>
              {ordered.map((day) => (
                <option key={day.day} value={day.day} disabled={day.runCount === 0}>
                  {day.day}: {day.runCount} {day.runCount === 1 ? 'run' : 'runs'}, {day.passed}{' '}
                  passed, {day.failed} failed, {day.errored} errored, {day.skipped} skipped
                </option>
              ))}
            </select>
          </label>
          <button
            className="attest-chart-action"
            type="button"
            onPointerDown={focusChartAction}
            onMouseDown={focusChartAction}
            aria-disabled={!actionDay || actionDay.runCount === 0 || actionDay.day === selectedDay}
            onFocus={() => {
              if (actionDay) inspection.inspect(actionDay.day);
            }}
            onClick={() => {
              if (actionDay) selectDay(actionDay);
            }}
          >
            {actionDay && actionDay.runCount > 0
              ? `${actionDay.day === selectedDay ? 'Selected day' : 'Select day'} ${actionDay.day}`
              : 'Choose a day to select'}
          </button>
        </div>
      )}
      <svg
        viewBox={`0 0 ${chartWidth} 220`}
        onMouseMove={dense ? (event) => setHovered(nearest(event)?.day ?? null) : undefined}
        onMouseLeave={() => setHovered(null)}
        onPointerDown={
          dense
            ? (event) => {
                gesture.current = {
                  id: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  nonmouse: event.pointerType !== 'mouse',
                  moved: false,
                };
              }
            : undefined
        }
        onPointerMove={
          dense
            ? (event) => {
                const start = gesture.current;

                if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
                  start.moved = true;
              }
            : undefined
        }
        onPointerCancel={() => {
          gesture.current = null;
        }}
        onPointerUp={
          dense
            ? (event) => {
                const start = gesture.current;

                if (
                  start?.nonmouse &&
                  !start.moved &&
                  start.id === event.pointerId &&
                  Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8
                ) {
                  const day = nearest(event);

                  if (day) selectDay(day);
                }
              }
            : undefined
        }
        onClick={
          dense
            ? (event) => {
                if (gesture.current?.nonmouse || gesture.current?.moved) return;
                const day = nearest(event);

                if (day) selectDay(day);
              }
            : undefined
        }
        style={{
          cursor:
            dense && ordered.some((day) => day.day === hovered && day.runCount > 0)
              ? 'pointer'
              : undefined,
        }}
        role="group"
        aria-label={`${label}. Passed above zero; failed and errored below zero, on the same count scale.`}
      >
        {[
          { role: 'up', y: 18, value: up },
          { role: 'zero', y: zero, value: 0 },
          { role: 'down', y: 178, value: -down },
        ].map((tick) =>
          (tick.role !== 'zero' && tick.value === 0) ||
          (tick.value !== 0 && Math.abs(tick.y - zero) < 16) ? null : (
            <g key={tick.role} aria-hidden="true">
              <line className="attest-chart-grid" x1="44" x2={right} y1={tick.y} y2={tick.y} />
              <text x="38" y={tick.y + 4} textAnchor="end">
                {Math.abs(tick.value)}
              </text>
            </g>
          ),
        )}
        {ordered.map((day, index) => {
          const cx = 44 + slot * (index + 0.5);
          const inert = dense || day.runCount === 0;

          return (
            <g key={day.day}>
              <g
                aria-hidden={dense || undefined}
                role={inert ? undefined : 'button'}
                // Keep the focused mark reachable until the chooser takes focus.
                tabIndex={!inert || (dense && focused === day.day) ? 0 : undefined}
                data-chart-mark={inert ? undefined : ''}
                data-day={day.day}
                aria-pressed={inert ? undefined : selectedDay === day.day}
                className={`${dense ? 'attest-chart-dense-mark' : day.runCount > 0 ? 'attest-chart-mark' : 'attest-chart-static-mark'} ${active === day ? 'is-active' : ''}`}
                aria-label={`${day.day}: ${day.runCount} ${day.runCount === 1 ? 'run' : 'runs'}, ${day.passed} passed, ${day.failed} failed, ${day.errored} errored, ${day.skipped} skipped.${day.runCount > 0 ? ' Select day.' : ' No runs to select.'}`}
                onClick={inert ? undefined : () => selectDay(day)}
                onKeyDown={(event) => {
                  moveChartFocus(event);

                  if (!inert && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    selectDay(day);
                  }
                }}
                onMouseEnter={dense ? undefined : () => setHovered(day.day)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setFocused(day.day)}
                onBlur={() => setFocused(null)}
              >
                <rect
                  className="attest-chart-hit"
                  x={cx - slot / 2}
                  y="10"
                  width={slot}
                  height="180"
                />
                <rect
                  className="attest-chart-bar-pass"
                  x={cx - width / 2}
                  y={zero - day.passed * scale}
                  width={width}
                  height={day.passed * scale}
                />
                <rect
                  className="attest-chart-bar-fail"
                  x={cx - width / 2}
                  y={zero}
                  width={width}
                  height={
                    day.failed + day.errored > 0
                      ? Math.max(2, (day.failed + day.errored) * scale)
                      : 0
                  }
                />
                {day.passed + day.failed + day.errored === 0 && (
                  <line className="attest-chart-grid" x1={cx - 2} x2={cx + 2} y1={zero} y2={zero} />
                )}
              </g>
              {selectedDay === day.day && (
                <path
                  className="attest-chart-selection attest-chart-day-selection"
                  d={`M${cx - 4},188 h8 l-4,5 Z`}
                />
              )}
              {(index === 0 || index === ordered.length - 1) && (
                <text x={cx} y="212" textAnchor={index === 0 ? 'start' : 'end'}>
                  {day.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
        {totals.runCount === 0 && (
          <text className="attest-chart-empty" x={chartWidth / 2} y="100" textAnchor="middle">
            No activity in this window
          </text>
        )}
      </svg>
      <p className="attest-chart-key">
        Ink: passed. Orange below zero: failed or errored. Select a day to view its runs. Nonzero
        failures have a 2px minimum for visibility; readout gives exact counts. Triangle marks the
        selected day.
      </p>
    </section>
  );
}

export { DailyActivity, type DailyActivityProps };
