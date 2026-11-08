import { useId, useMemo, useState } from 'react';
import { countsLabel } from '../../meters/proportions.js';
import { moveChartFocus } from './chart-keyboard.js';
import type { EvalSlice } from '@attest/core/records';
import { prepareTrend, type TrendAxis } from './trend-model.js';
import {
  useChartWidth,
  focusChartAction,
  useDenseFocus,
  nativeHitRegions,
  resolveActive,
  calendarDate,
  calendarTime,
  useInspection,
  axisIdentity,
} from './chart-layout.js';
import './compact-charts.css';

type PassRateTrendProps = {
  /** At most 200 eval slices, scoped to one eval and source. */
  runs: readonly EvalSlice[];
  axis: TrendAxis;
  onAxisChange: (axis: TrendAxis) => void;
  runHref: (run: EvalSlice) => string;
  /** Also allows a table row to drive the chart readout. */
  selectedRunId?: string;
  label: string;
};

/** Keep the full run id and its branch consistent across inspection controls. */
function runName(run: EvalSlice) {
  return run.gitBranch === null ? run.runId : `${run.runId}, ${run.gitBranch}`;
}

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/** Hosts key this component by project/source/eval and explicit query-window context.
 * Appended polling results keep that key so valid inspection survives.
 * A complete eval slice joins the ink line even when another eval failed its run. */
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

  const inspection = useInspection(
    selectedRunId,
    JSON.stringify([label, axis]),
    points.map(({ run }) => run.runId),
  );

  const { ref, width } = useChartWidth();

  const completed = points.filter(
    (point): point is typeof point & { rate: number } => point.rate !== null,
  );

  const active =
    resolveActive(points, ({ run }) => run.runId, [
      hovered,
      focused,
      inspection.id,
      selectedRunId,
    ]) ??
    completed.at(-1) ??
    points.at(-1);

  // Readout follows transient input; activation follows explicit inspection or host selection.
  const action =
    resolveActive(points, ({ run }) => run.runId, [inspection.id, selectedRunId]) ??
    completed.at(-1) ??
    points.at(-1);

  const selected = points.find(({ run }) => run.runId === selectedRunId);
  const right = Math.max(68, width - 22);
  const x = (value: number) => 44 + value * (right - 44);
  const minimum = Math.min(0.5, ...completed.map(({ rate }) => rate));
  const y = (rate: number) => 18 + ((1 - rate) / (1 - minimum)) * 150;

  const hitId = useId();

  const centers = useMemo(
    () =>
      points.map((point) => ({
        x: 44 + point.x * (right - 44),
        y: point.rate === null ? 198 : 18 + ((1 - point.rate) / (1 - minimum)) * 150,
      })),
    [points, right, minimum],
  );

  const hitRegions = useMemo(() => nativeHitRegions(centers), [centers]);

  const path = completed
    .map((point, index) => `${index ? 'L' : 'M'}${x(point.x)},${y(point.rate)}`)
    .join(' ');

  // Density depends only on data and width; native links keep the same DOM identity.
  const dense = centers.some((center, index) =>
    centers
      .slice(0, index)
      .some((other) => Math.abs(center.x - other.x) < 24 && Math.abs(center.y - other.y) < 24),
  );

  const timeLabel = active ? `${calendarTime(active.startedAt)}. ${active.run.runStatus}.` : '';

  const comparisonLabel =
    !active || active.rate === null
      ? 'No pass rate for this slice; comparison needs a complete slice.'
      : active.comparison
        ? `${active.comparison.selectionChanged ? 'Selection counts differ. ' : ''}${active.comparison.points > 0 ? '+' : ''}${active.comparison.points.toFixed(1)} pp versus prior complete slice.`
        : 'No earlier complete slice for comparison.';

  const countLabel = active
    ? `${active.run.counts.recorded}/${active.run.counts.planned ?? 'unknown'} recorded/planned. ${active.run.counts.passed} pass, ${active.run.counts.failed} fail, ${active.run.counts.errored} error, ${active.run.counts.skipped} skipped.`
    : '';

  useDenseFocus(dense, ref);

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
            <span title={timeLabel}>{timeLabel}</span>
            <span
              title={comparisonLabel}
              className={
                active.comparison && active.comparison.points < 0 ? 'attest-chart-decline' : ''
              }
            >
              {comparisonLabel}
            </span>
            <span title={countLabel}>{countLabel}</span>
            <span className="attest-chart-identity" title={runName(active.run)}>
              Run {runName(active.run)}
            </span>
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
              value={action?.run.runId ?? ''}
              onFocus={() => {
                // A density transition carries the mark being inspected into this chooser.
                const next = resolveActive(points, ({ run }) => run.runId, [focused]) ?? action;

                if (next) inspection.inspect(next.run.runId);
              }}
              onChange={(event) => {
                setHovered(null);
                inspection.inspect(event.target.value);
              }}
            >
              {points.map(({ run, startedAt }) => (
                <option key={run.runId} value={run.runId}>
                  {calendarTime(startedAt)} · {runName(run)} · {run.state}, run {run.runStatus} ·{' '}
                  {run.state === 'complete' ? percent(run.passRate) : 'no rate'} ·{' '}
                  {countsLabel(run.counts)}
                </option>
              ))}
            </select>
          </label>
          {action && (
            <a
              className="attest-chart-action"
              href={runHref(action.run)}
              title={`Open run ${action.run.runId}`}
              onPointerDown={focusChartAction}
              onMouseDown={focusChartAction}
              onFocus={() => inspection.inspect(action.run.runId)}
            >
              Open run {action.run.runId}
            </a>
          )}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} 230`}
        onMouseLeave={() => setHovered(null)}
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
          const { x: cx, y: cy } = centers[index]!;

          const decline = point.comparison !== null && point.comparison.points < 0;

          const previous =
            completed[completed.findIndex((item) => item.run.runId === point.run.runId) - 1];

          return (
            <g key={point.run.runId}>
              {decline && previous && (
                <path
                  className="attest-chart-down-line"
                  d={`M${x(previous.x)},${y(previous.rate)} L${cx},${cy}`}
                />
              )}
              <a
                href={runHref(point.run)}
                tabIndex={dense ? -1 : undefined}
                data-chart-mark={dense ? undefined : ''}
                onKeyDown={dense ? undefined : moveChartFocus}
                aria-hidden={dense || undefined}
                aria-label={
                  dense
                    ? undefined
                    : `Run ${runName(point.run)}, ${calendarTime(point.startedAt)}, slice ${point.run.state}, run ${point.run.runStatus}, ${point.rate === null ? 'no pass rate' : percent(point.rate)}, ${countsLabel(point.run.counts)}. Open run.`
                }
                onMouseEnter={() => setHovered(point.run.runId)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setFocused(point.run.runId)}
                onBlur={() => setFocused(null)}
                className={`${dense ? 'attest-chart-native-mark' : 'attest-chart-mark'} ${active === point ? 'is-active' : ''}`}
              >
                <title>{point.run.runId}</title>
                {dense ? (
                  <>
                    <clipPath id={`${hitId}-${index}`}>
                      <circle cx={cx} cy={cy} r="24" />
                    </clipPath>
                    <path
                      className="attest-chart-hit"
                      d={hitRegions[index]}
                      clipPath={`url(#${hitId}-${index})`}
                    />
                  </>
                ) : (
                  <rect
                    className="attest-chart-hit"
                    x={cx - 12}
                    y={cy - 12}
                    width="24"
                    height="24"
                  />
                )}
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
              </a>
              {(index === 0 || (index === points.length - 1 && point.x !== points[0]?.x)) && (
                <text x={cx} y="225" textAnchor={index === 0 ? 'start' : 'end'}>
                  {axis === 'run' ? axisIdentity(point.run.runId) : calendarDate(point.startedAt)}
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
        {points.length > 0 && completed.length === 0 && (
          <text className="attest-chart-empty" x={width / 2} y="100" textAnchor="middle">
            No complete slices
          </text>
        )}
      </svg>
      {points.length > 0 && (
        <p className="attest-chart-key">
          {completed.some((point) => !point.comparison || point.comparison.points >= 0) &&
            'Ink dot: complete slice. '}
          {points.some((point) => point.rate === null) &&
            'Hollow lower rail: running or incomplete slice, no rate. '}
          {completed.some(
            (point) => point.run.counts.failed + point.run.counts.errored > 0 && point.rate < 1,
          ) && 'Orange bars: failure shortfall from 100%. '}
          {completed.some((point) => point.comparison && point.comparison.points < 0) &&
            '▼: lower pass rate. '}
          {selected && 'Selected run: dashed ring. '}
          Rate changes do not establish case regressions.{' '}
          {dense &&
            'Overlapping marks: use Inspect run to access every identity at its exact timestamp.'}
        </p>
      )}
    </section>
  );
}

export { PassRateTrend, type PassRateTrendProps };
