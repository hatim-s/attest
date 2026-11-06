import { useMemo, useState, type MouseEvent } from 'react';
import { countsLabel } from '../../meters/proportions.js';
import { moveChartFocus } from './chart-keyboard.js';
import { prepareTrend, type TrendAxis, type TrendRun } from './trend-model.js';
import {
  useChartWidth,
  resolveActive,
  calendarDate,
  calendarTime,
  timezoneLabel,
  useInspection,
  plotPointer,
  axisIdentity,
} from './chart-layout.js';
import './compact-charts.css';

type PassRateTrendProps = {
  /** At most 200 decoded eval summaries, scoped to one eval and source. */
  runs: readonly TrendRun[];
  axis: TrendAxis;
  utcOffsetMinutes: number;
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
  utcOffsetMinutes,
  onAxisChange,
  runHref,
  selectedRunId,
  label,
}: PassRateTrendProps) {
  const points = useMemo(() => prepareTrend(runs, axis), [runs, axis]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const inspection = useInspection(
    selectedRunId,
    JSON.stringify([axis, utcOffsetMinutes, points.map(({ run }) => [run.id, run.startedAt])]),
  );

  const { ref, width } = useChartWidth();

  const completed = points.filter(
    (point): point is typeof point & { rate: number } => point.rate !== null,
  );

  const active =
    resolveActive(points, ({ run }) => run.id, [hovered, focused, inspection.id, selectedRunId]) ??
    completed.at(-1) ??
    points.at(-1);

  const selected = points.find(({ run }) => run.id === selectedRunId);
  const right = Math.max(68, width - 22);
  const x = (value: number) => 44 + value * (right - 44);
  const minimum = Math.min(0.5, ...completed.map(({ rate }) => rate));
  const y = (rate: number) => 18 + ((1 - rate) / (1 - minimum)) * 150;

  const path = completed
    .map((point, index) => `${index ? 'L' : 'M'}${x(point.x)},${y(point.rate)}`)
    .join(' ');

  // Dense marks keep true coordinates; one plot target finds the nearest point.
  const dense = points.some((point, index) =>
    points
      .slice(0, index)
      .some(
        (other) =>
          Math.abs(x(point.x) - x(other.x)) < 24 &&
          Math.abs(
            (point.rate === null ? 198 : y(point.rate)) -
              (other.rate === null ? 198 : y(other.rate)),
          ) < 24,
      ),
  );

  const nearest = (event: MouseEvent<SVGSVGElement>) => {
    const pointer = plotPointer(event, width, 230);

    if (pointer.x < 32 || pointer.x > right + 12 || pointer.y < 6 || pointer.y > 210)
      return undefined;

    return points.reduce<(typeof points)[number] | undefined>((best, point) => {
      const distance = (item: (typeof points)[number]) =>
        Math.hypot(x(item.x) - pointer.x, (item.rate === null ? 198 : y(item.rate)) - pointer.y);

      return !best || distance(point) < distance(best) ? point : best;
    }, undefined);
  };

  const Mark = dense ? 'g' : 'a';

  return (
    <section ref={ref} className="attest-compact-chart" aria-label={label}>
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
      <div className="attest-chart-readout">
        {active ? (
          <>
            <strong>{active.rate === null ? active.run.state : percent(active.rate)}</strong>
            <span>
              Run {active.run.id}
              {active.run.label &&
              active.run.label !== active.run.id &&
              active.run.label !== `Run ${active.run.id}`
                ? `, ${active.run.label}`
                : ''}
              , {calendarTime(active.run.startedAt, utcOffsetMinutes)}{' '}
              {timezoneLabel(utcOffsetMinutes)}. Run status {active.run.runStatus}.
            </span>
            <span>
              {countsLabel(active.run.counts)}. {active.run.counts.recorded} recorded of{' '}
              {active.run.counts.planned ?? 'unknown'} planned.
              {active.rate === null
                ? ' No pass rate.'
                : ' Supplied pass rate for this complete eval slice.'}
            </span>
            {active.comparison && (
              <span className={active.comparison.points < 0 ? 'attest-chart-decline' : ''}>
                {active.comparison.points > 0 ? '+' : ''}
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
      {points.length > 0 && (
        <div className="attest-chart-chooser" onBlur={inspection.onBlur}>
          <label>
            Inspect run{' '}
            <select
              value={active?.run.id ?? ''}
              onChange={(event) => {
                setHovered(null);
                inspection.inspect(event.target.value);
              }}
            >
              {points.map(({ run }) => (
                <option key={run.id} value={run.id}>
                  {run.id} · {run.state} ·{' '}
                  {run.state === 'complete' ? percent(run.passRate) : 'no rate'} ·{' '}
                  {countsLabel(run.counts)}
                </option>
              ))}
            </select>
          </label>
          {active && <a href={runHref(active.run)}>Open run {active.run.id}</a>}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} 230`}
        onMouseMove={dense ? (event) => setHovered(nearest(event)?.run.id ?? null) : undefined}
        onMouseLeave={() => setHovered(null)}
        onClick={
          dense
            ? (event) => {
                const point = nearest(event);

                if (point) globalThis.location.assign(runHref(point.run));
              }
            : undefined
        }
        className={dense ? 'attest-chart-dense' : undefined}
        role="group"
        aria-label={`${label}. Complete slices on the line; other slices on the lower rail.`}
      >
        {[minimum, (1 + minimum) / 2, 1].map((rate) => (
          <g key={rate} aria-hidden="true">
            <line className="attest-chart-grid" x1="44" x2={right} y1={y(rate)} y2={y(rate)} />
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
        <line className="attest-chart-grid" x1="44" x2={right} y1="198" y2="198" />
        {points.map((point, index) => {
          const cx = x(point.x),
            cy = point.rate === null ? 198 : y(point.rate);

          const decline = point.comparison !== null && point.comparison.points < 0;

          const previous =
            completed[completed.findIndex((item) => item.run.id === point.run.id) - 1];

          return (
            <g key={point.run.id}>
              {decline && previous && (
                <path
                  className="attest-chart-down-line"
                  d={`M${x(previous.x)},${y(previous.rate)} L${cx},${cy}`}
                />
              )}
              <Mark
                href={dense ? undefined : runHref(point.run)}
                data-chart-mark={dense ? undefined : ''}
                onKeyDown={dense ? undefined : moveChartFocus}
                aria-hidden={dense || undefined}
                aria-label={
                  dense
                    ? undefined
                    : `Run ${point.run.id}${point.run.label && point.run.label !== point.run.id && point.run.label !== `Run ${point.run.id}` ? `, ${point.run.label}` : ''}, ${calendarTime(point.run.startedAt, utcOffsetMinutes)} ${timezoneLabel(utcOffsetMinutes)}, slice ${point.run.state}, run ${point.run.runStatus}, ${point.rate === null ? 'no pass rate' : percent(point.rate)}, ${countsLabel(point.run.counts)}. Open run.`
                }
                onMouseEnter={dense ? undefined : () => setHovered(point.run.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={dense ? undefined : () => setFocused(point.run.id)}
                onBlur={() => setFocused(null)}
                className={`${dense ? 'attest-chart-dense-mark' : 'attest-chart-mark'} ${active === point ? 'is-active' : ''}`}
              >
                <title>{point.run.id}</title>
                <rect className="attest-chart-hit" x={cx - 12} y={cy - 12} width="24" height="24" />
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
                    className={`attest-chart-point ${point.rate === null ? `rail-${point.run.state}` : ''}`}
                    cx={cx}
                    cy={cy}
                    r="4"
                  />
                )}
              </Mark>
              {(index === 0 || (index === points.length - 1 && point.x !== points[0]?.x)) && (
                <text x={cx} y="225" textAnchor={index === 0 ? 'start' : 'end'}>
                  {axis === 'run'
                    ? axisIdentity(point.run.id)
                    : calendarDate(point.run.startedAt, utcOffsetMinutes)}
                </text>
              )}
            </g>
          );
        })}
        {selected && (
          <circle
            className="attest-chart-selection"
            cx={x(selected.x)}
            cy={selected.rate === null ? 198 : y(selected.rate)}
            r="11"
          />
        )}
        {completed.length === 0 && (
          <text x={width / 2} y="100" textAnchor="middle">
            No complete slices
          </text>
        )}
      </svg>
      <p className="attest-chart-key">
        Ink dot: complete slice. Hollow lower rail: running or incomplete slice. Orange bars:
        failure shortfall from 100%. ▼: lower pass rate. Lower rail: no rate. Selected run: dashed
        ring.{' '}
        {dense
          ? 'Overlapping marks: use Inspect run to access every identity at its exact timestamp.'
          : ''}
      </p>
    </section>
  );
}

export { PassRateTrend, type PassRateTrendProps };
