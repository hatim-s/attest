import { useCallback, useMemo } from 'react';
import { ChartCard } from '../charts/chart-card.js';
import {
  categoryAxis,
  valueAxis,
  type ChartOptions,
  type ChartPalette,
} from '../charts/use-chart.js';
import { formatDateTime, formatShortDateTime, shortId } from '../../lib/format.js';

type ChartRun = { id: string; createdAt: string; gitBranch?: string; gitSha?: string };

/** The full run id keeps each category unique; the tooltip shows every line. */
const describeRun = ({ id, createdAt, gitBranch, gitSha }: ChartRun): string =>
  [
    formatDateTime(createdAt),
    `Run ${id}`,
    gitBranch === undefined ? '' : `Branch ${gitBranch}`,
    gitSha === undefined ? '' : `Commit ${shortId(gitSha, 7)}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

type Tick = { run: ChartRun; label: string };

/** Rewrites only the ticks whose label another tick in the same chart already uses. */
const disambiguate = (ticks: Tick[], refine: (tick: Tick) => string): Tick[] => {
  const seen = ticks.map(({ label }) => label);
  const repeated = new Set(seen.filter((label, index) => seen.indexOf(label) !== index));

  return ticks.map((tick) => (repeated.has(tick.label) ? { ...tick, label: refine(tick) } : tick));
};

/**
 * Minute ticks by default. Runs that share a minute get seconds, and runs that still share a
 * second get the end of their id, since ULIDs from the same second share their prefix.
 */
const runTickLabels = (runs: ChartRun[]): string[] => {
  const minutes = runs.map((run) => ({ run, label: formatShortDateTime(run.createdAt) }));
  const seconds = disambiguate(minutes, ({ run }) => formatShortDateTime(run.createdAt, 'second'));

  return disambiguate(seconds, ({ run, label }) => `${label} · ${run.id.slice(-4)}`).map(
    ({ label }) => label,
  );
};

type AnalyticsChartProps = {
  title: string;
  /** Oldest first, one per value. */
  runs: ChartRun[];
  values: (number | null)[];
  measure: string;
  min?: number;
  max?: number;
  formatValue: (value: number) => string;
  /** Shown instead of the chart when every value is null. */
  emptyMessage?: string;
};

/** Shares chart anatomy so histories and recent-run trends have identical scales and tooltips. */
const AnalyticsChart = ({
  title,
  runs,
  values,
  measure,
  formatValue,
  min,
  max,
  emptyMessage,
}: AnalyticsChartProps) => {
  const labels = useMemo(() => runs.map(describeRun), [runs]);
  const ticks = useMemo(() => runTickLabels(runs), [runs]);

  const option = useCallback(
    (palette: ChartPalette): ChartOptions => ({
      grid: { left: 65, right: 25, top: 40, bottom: 55 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', snap: true },
        // Reads the typed series by index; ECharts hands the callback its own loose value type.
        valueFormatter: (_value, dataIndex) => {
          const value = values[dataIndex];

          return value === null || value === undefined ? 'Unscored' : formatValue(value);
        },
      },
      xAxis: categoryAxis(palette, 'Run started', labels, (_label, index) => ticks[index] ?? ''),
      yAxis: {
        ...valueAxis(palette, measure),
        min,
        max,
        axisLabel: { color: palette.muted, formatter: formatValue },
      },
      series: [
        {
          type: 'line',
          name: measure,
          data: values,
          connectNulls: false,
          symbolSize: 8,
          lineStyle: { width: 2, color: palette['series-1'] },
          itemStyle: { color: palette['series-1'], borderColor: palette.surface, borderWidth: 2 },
        },
      ],
    }),
    [labels, ticks, values, measure, formatValue, min, max],
  );

  return (
    <ChartCard
      title={title}
      option={option}
      emptyMessage={values.every((value) => value === null) ? emptyMessage : undefined}
    />
  );
};

export { AnalyticsChart, runTickLabels, type ChartRun };
