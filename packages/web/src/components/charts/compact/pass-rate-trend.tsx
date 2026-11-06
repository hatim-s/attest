import { useMemo, useState } from 'react';
import { countsLabel } from '../../meters/proportions.js';
import { moveChartFocus } from './chart-keyboard.js';
import { prepareTrend, type TrendAxis, type TrendRun } from './trend-model.js';
import './compact-charts.css';

type PassRateTrendProps = {
  /** At most 200 decoded eval summaries, scoped to one eval and source. */
  runs: readonly TrendRun[];
  axis: TrendAxis;
  onAxisChange: (axis: TrendAxis) => void;
  runHref: (run: TrendRun) => string;
  /** Also allows a table row to drive the chart readout. */
  selectedRunId?: string;
  label: string;
};

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/** A complete eval slice joins the ink line even when another eval failed its run. */
function PassRateTrend({
  runs,
  axis,
  onAxisChange,
  runHref,
  selectedRunId,
  label,
}: PassRateTrendProps) {
  const points = useMemo(() => prepareTrend(runs, axis), [runs, axis]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const completed = points.filter((point) => point.rate !== null);
  const activeId = focused ?? hovered ?? selectedRunId;
  const active = points.find(({ run }) => run.id === activeId) ?? completed.at(-1) ?? points.at(-1);
  const x = (value: number) => 44 + value * 600;
  const minimum = Math.min(0.5, ...completed.map(({ rate }) => rate ?? 1));
  const y = (rate: number) => 18 + ((1 - rate) / (1 - minimum)) * 150;

  const path = completed
    .map((point, index) => `${index ? 'L' : 'M'}${x(point.x)},${y(point.rate ?? 0)}`)
    .join(' ');

  return (
    <section className="attest-compact-chart" aria-label={label}>
      <div className="attest-chart-heading">
        <h3>{label}</h3>
        <div role="group" aria-label="Horizontal axis">
          {(['run', 'date'] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              aria-pressed={axis === mode}
              onClick={() => onAxisChange(mode)}
            >
              By {mode}
            </button>
          ))}
        </div>
      </div>
      <div className="attest-chart-readout" aria-live="polite" aria-atomic="true">
        {active ? (
          <>
            <strong>{active.rate === null ? active.run.state : percent(active.rate)}</strong>
            <span>
              {active.run.label}. Run {active.run.id},{' '}
              {new Date(active.run.startedAt).toISOString()}. Run status {active.run.runStatus}.
            </span>
            <span>
              {countsLabel(active.run.counts)}. {active.run.counts.recorded} recorded of{' '}
              {active.run.counts.planned ?? 'unknown'} planned.
              {active.rate === null
                ? ' No pass rate.'
                : ` Rate uses ${active.run.counts.recorded} recorded cases in this complete slice.`}
            </span>
            {active.comparison && (
              <span className={active.comparison.points < 0 ? 'attest-chart-decline' : ''}>
                {active.comparison.points.toFixed(1)} percentage points versus{' '}
                {active.comparison.previousId}.
                {active.comparison.selectionChanged ? ' Selection counts differ.' : ''} Rate changes
                do not establish case regressions.
              </span>
            )}
          </>
        ) : (
          <span>No eval slices in this window.</span>
        )}
      </div>
      <svg
        viewBox="0 0 700 230"
        role="group"
        aria-label={`${label}. Complete slices on the line; other slices on the lower rail.`}
      >
        {[minimum, (1 + minimum) / 2, 1].map((rate) => (
          <g key={rate} aria-hidden="true">
            <line className="attest-chart-grid" x1="44" x2="644" y1={y(rate)} y2={y(rate)} />
            <text x="38" y={y(rate) + 4} textAnchor="end">
              {Math.round(rate * 100)}%
            </text>
          </g>
        ))}
        {completed.length > 1 && (
          <path
            className="attest-chart-area"
            d={`${path} L${x(completed.at(-1)?.x ?? 0)},168 L${x(completed[0]?.x ?? 0)},168 Z`}
          />
        )}
        <path className="attest-chart-line" d={path} />
        <line className="attest-chart-grid" x1="44" x2="644" y1="198" y2="198" />
        {points.map((point, index) => {
          const cx = x(point.x),
            cy = point.rate === null ? 198 : y(point.rate);

          const decline = point.comparison !== null && point.comparison.points < 0;
          const previous = completed[completed.indexOf(point) - 1];

          return (
            <g key={point.run.id}>
              {decline && previous && (
                <path
                  className="attest-chart-down-line"
                  d={`M${x(previous.x)},${y(previous.rate ?? 0)} L${cx},${cy}`}
                />
              )}
              <a
                href={runHref(point.run)}
                data-chart-mark=""
                onKeyDown={moveChartFocus}
                aria-label={`Run ${point.run.id}, ${point.run.label}, slice ${point.run.state}, run ${point.run.runStatus}, ${point.rate === null ? 'no pass rate' : percent(point.rate)}, ${countsLabel(point.run.counts)}. Open run.`}
                onMouseEnter={() => setHovered(point.run.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setFocused(point.run.id)}
                onBlur={() => setFocused(null)}
                className={`attest-chart-mark ${active === point ? 'is-active' : ''}`}
              >
                <title>{point.run.label}</title>
                <rect className="attest-chart-hit" x={cx - 7} y={cy - 12} width="14" height="24" />
                {point.rate !== null && point.run.counts.failed + point.run.counts.errored > 0 && (
                  <rect
                    className="attest-chart-shortfall"
                    x={cx - 2}
                    y="18"
                    width="4"
                    height={cy - 18}
                  />
                )}
                {active === point && <circle className="attest-chart-halo" cx={cx} cy={cy} r="9" />}
                {decline ? (
                  <path className="attest-chart-triangle" d={`M${cx - 5},${cy - 4} h10 l-5,9 Z`} />
                ) : (
                  <circle
                    className={`attest-chart-point ${point.rate === null ? `rail-${point.run.runStatus}` : ''}`}
                    cx={cx}
                    cy={cy}
                    r="4"
                  />
                )}
              </a>
              {(index === 0 || index === points.length - 1) && (
                <text x={cx} y="225" textAnchor="middle">
                  {axis === 'run'
                    ? point.run.label
                    : new Date(point.run.startedAt).toISOString().slice(0, 10)}
                </text>
              )}
            </g>
          );
        })}
        {completed.length === 0 && (
          <text x="344" y="100" textAnchor="middle">
            No complete slice with a nonzero denominator
          </text>
        )}
      </svg>
      <p className="attest-chart-key">
        Ink: complete slice. Pale bars: failure shortfall from 100%. ▼: lower pass rate. Lower rail:
        no rate.
      </p>
    </section>
  );
}

export { PassRateTrend, type PassRateTrendProps };
