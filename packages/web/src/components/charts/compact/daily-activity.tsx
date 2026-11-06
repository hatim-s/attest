import { useMemo, useState } from 'react';
import { moveChartFocus } from './chart-keyboard.js';
import { prepareActivity, type ActivityDay, type ActivityWindow } from './daily-model.js';
import { useChartWidth, resolveActive, timezoneLabel } from './chart-layout.js';
import './compact-charts.css';

type DailyActivityProps = {
  /** Sparse daily aggregates in the declared calendar window, at most 92 buckets. */
  days: readonly ActivityDay[];
  window: ActivityWindow;
  selectedDay?: string;
  onSelectDay: (day: string) => void;
  label?: string;
};

/** Selecting a real calendar day lets the caller load its bounded run list. */
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

  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const { ref, width: chartWidth } = useChartWidth();
  const active = resolveActive(ordered, (day) => day.day, [hovered, focused, selectedDay]);
  const right = Math.max(68, chartWidth - 22);
  const counts = active ?? totals;
  const scale = 160 / (up + down);
  const zero = 18 + up * scale;
  const slot = (right - 44) / Math.max(1, ordered.length);
  const width = Math.min(14, slot * 0.6);

  const dense = slot < 24;

  return (
    <section ref={ref} className="attest-compact-chart" aria-label={label}>
      <h3>{label}</h3>
      <div className="attest-chart-readout">
        <strong>{counts.passed + counts.failed + counts.errored} cases ran</strong>
        <span>
          {active?.day ?? 'Window total'}, {counts.runCount}{' '}
          {counts.runCount === 1 ? 'run' : 'runs'}. {timezoneLabel(window.utcOffsetMinutes)}.
        </span>
        <span>
          {counts.passed} passed, {counts.failed} failed, {counts.errored} errored, {counts.skipped}{' '}
          skipped. Skipped cases are excluded from bars.
        </span>
      </div>
      {dense && (
        <label className="attest-chart-chooser">
          Inspect day{' '}
          <select
            value={active?.day ?? ''}
            onChange={(event) => {
              setHovered(null);
              setFocused(event.target.value);
            }}
          >
            <option value="" disabled>
              Choose a day
            </option>
            {ordered.map((day) => (
              <option key={day.day} value={day.day}>
                {day.day}: {day.runCount} {day.runCount === 1 ? 'run' : 'runs'}
              </option>
            ))}
          </select>
        </label>
      )}
      {active && active.runCount > 0 && (
        <button type="button" onClick={() => onSelectDay(active.day)}>
          View runs for {active.day}
        </button>
      )}
      <svg
        viewBox={`0 0 ${chartWidth} 220`}
        role="group"
        aria-label={`${label}. Passed above zero; failed and errored below zero, on the same count scale.`}
      >
        {[
          { y: 18, value: up },
          { y: zero, value: 0 },
          { y: 178, value: -down },
        ].map((tick) =>
          tick.value !== 0 && Math.abs(tick.y - zero) < 16 ? null : (
            <g key={Math.abs(tick.value)} aria-hidden="true">
              <line className="attest-chart-grid" x1="44" x2={right} y1={tick.y} y2={tick.y} />
              <text x="38" y={tick.y + 4} textAnchor="end">
                {Math.abs(tick.value)}
              </text>
            </g>
          ),
        )}
        {ordered.map((day, index) => {
          const cx = 44 + slot * (index + 0.5);

          return (
            <g key={day.day}>
              <g
                role={dense || day.runCount === 0 ? undefined : 'button'}
                tabIndex={dense || day.runCount === 0 ? undefined : 0}
                data-chart-mark={dense || day.runCount === 0 ? undefined : ''}
                aria-pressed={dense || day.runCount === 0 ? undefined : selectedDay === day.day}
                className={`attest-chart-mark ${active === day ? 'is-active' : ''}`}
                aria-label={`${day.day}: ${day.runCount} ${day.runCount === 1 ? 'run' : 'runs'}, ${day.passed} passed, ${day.failed} failed, ${day.errored} errored, ${day.skipped} skipped.${day.runCount > 0 ? ' Select day.' : ' No runs to select.'}`}
                onClick={dense || day.runCount === 0 ? undefined : () => onSelectDay(day.day)}
                onKeyDown={(event) => {
                  moveChartFocus(event);

                  if (!dense && day.runCount > 0 && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onSelectDay(day.day);
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
                <path className="attest-chart-selection" d={`M${cx - 4},188 h8 l-4,5 Z`} />
              )}
              {(index === 0 || index === ordered.length - 1) && (
                <text x={cx} y="212" textAnchor={index === 0 ? 'start' : 'end'}>
                  {day.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
        {ordered.length === 0 && (
          <text x={chartWidth / 2} y="100" textAnchor="middle">
            No activity in this window
          </text>
        )}
      </svg>
      <p className="attest-chart-key">
        Ink: passed. Below zero: failed or errored. Select a day to view its runs. Nonzero failures
        have a 2px minimum for visibility; readout gives exact counts. Triangle marks the selected
        day.
      </p>
    </section>
  );
}

export { DailyActivity, type DailyActivityProps };
