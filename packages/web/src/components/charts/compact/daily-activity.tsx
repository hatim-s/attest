import { useMemo, useState } from 'react';
import { moveChartFocus } from './chart-keyboard.js';
import { prepareActivity, type ActivityDay } from './daily-model.js';
import './compact-charts.css';

type DailyActivityProps = {
  /** Bounded daily aggregates including zero days, at most 92 days. */
  days: readonly ActivityDay[];
  selectedDay?: string;
  onSelectDay: (day: string) => void;
  label?: string;
};

/** Selecting a real calendar day lets the caller load its bounded run list. */
function DailyActivity({
  days,
  selectedDay,
  onSelectDay,
  label = 'Cases per day',
}: DailyActivityProps) {
  const { ordered, up, down, totals } = useMemo(() => prepareActivity(days), [days]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const active = ordered.find((day) => day.day === (focused ?? hovered ?? selectedDay));
  const counts = active ?? totals;
  const scale = 160 / (up + down);
  const zero = 18 + up * scale;
  const slot = 600 / Math.max(1, ordered.length);
  const width = Math.min(14, slot * 0.6);

  return (
    <section className="attest-compact-chart" aria-label={label}>
      <h3>{label}</h3>
      <div className="attest-chart-readout" aria-live="polite" aria-atomic="true">
        <strong>{counts.passed + counts.failed + counts.errored} cases ran</strong>
        <span>
          {active?.day ?? 'Window total'}, {counts.runCount} runs.
        </span>
        <span>
          {counts.passed} passed, {counts.failed} failed, {counts.errored} errored, {counts.skipped}{' '}
          skipped. Skipped cases are excluded from bars.
        </span>
      </div>
      <svg
        viewBox="0 0 700 220"
        role="group"
        aria-label={`${label}. Passed above zero; failed and errored below zero, on the same count scale.`}
      >
        {[
          { y: 18, value: up },
          { y: zero, value: 0 },
          { y: 178, value: -down },
        ].map((tick) => (
          <g key={tick.value} aria-hidden="true">
            <line className="attest-chart-grid" x1="44" x2="644" y1={tick.y} y2={tick.y} />
            <text x="38" y={tick.y + 4} textAnchor="end">
              {tick.value}
            </text>
          </g>
        ))}
        {ordered.map((day, index) => {
          const cx = 44 + slot * (index + 0.5);

          return (
            <g key={day.day}>
              <g
                role="button"
                tabIndex={0}
                data-chart-mark=""
                aria-pressed={selectedDay === day.day}
                className={`attest-chart-mark ${active === day ? 'is-active' : ''}`}
                aria-label={`${day.day}: ${day.runCount} runs, ${day.passed} passed, ${day.failed} failed, ${day.errored} errored, ${day.skipped} skipped. Select day.`}
                onClick={() => onSelectDay(day.day)}
                onKeyDown={(event) => {
                  moveChartFocus(event);

                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectDay(day.day);
                  }
                }}
                onMouseEnter={() => setHovered(day.day)}
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
                  height={(day.failed + day.errored) * scale}
                />
                {day.passed + day.failed + day.errored === 0 && (
                  <line className="attest-chart-grid" x1={cx - 2} x2={cx + 2} y1={zero} y2={zero} />
                )}
              </g>
              {(index === 0 || index === ordered.length - 1) && (
                <text x={cx} y="212" textAnchor="middle">
                  {day.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
        {ordered.length === 0 && (
          <text x="344" y="100" textAnchor="middle">
            No activity in this window
          </text>
        )}
      </svg>
      <p className="attest-chart-key">
        Ink: passed. Orange below zero: failed or errored. Select a day to view its runs.
      </p>
    </section>
  );
}

export { DailyActivity, type DailyActivityProps };
