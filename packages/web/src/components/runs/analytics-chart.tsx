import { useCallback, useMemo } from 'react';
import { ChartCard } from '../charts/chart-card.js';
import {
  categoryAxis,
  valueAxis,
  type ChartOptions,
  type ChartPalette,
} from '../charts/use-chart.js';
import { formatShortDateTime, shortId } from '../../lib/format.js';

type ChartRun = { id: string; createdAt: string; gitBranch?: string; gitSha?: string };

/**
 * The first line is the tick; the tooltip shows every line. Categories repeat when two runs
 * start in the same minute, which a category axis handles by position.
 */
const describeRun = ({ id, createdAt, gitBranch, gitSha }: ChartRun): string =>
  [
    formatShortDateTime(createdAt),
    `Run ${shortId(id)}`,
    gitBranch === undefined ? '' : `Branch ${gitBranch}`,
    gitSha === undefined ? '' : `Commit ${shortId(gitSha, 7)}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

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
      xAxis: categoryAxis(palette, 'Run started', labels, (label) => label.split('\n')[0] ?? ''),
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
    [labels, values, measure, formatValue, min, max],
  );

  return (
    <ChartCard
      title={title}
      option={option}
      emptyMessage={values.every((value) => value === null) ? emptyMessage : undefined}
    />
  );
};

export { AnalyticsChart, type ChartRun };
