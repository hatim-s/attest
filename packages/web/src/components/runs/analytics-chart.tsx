import { useCallback } from 'react';
import { type EChartsCoreOption } from 'echarts/core';
import { ChartCard } from '../charts/chart-card.js';
import { categoryAxis, valueAxis, type ChartPalette } from '../charts/use-chart.js';

/** Shares chart anatomy so histories and loaded-run trends have identical scales and tooltips. */
const AnalyticsChart = ({
  title,
  labels,
  values,
  measure,
  formatValue,
  min,
  max,
}: {
  title: string;
  labels: string[];
  values: (number | null)[];
  measure: string;
  min?: number;
  max?: number;
  formatValue: (value: number) => string;
}) => {
  const option = useCallback(
    (palette: ChartPalette): EChartsCoreOption => ({
      grid: { left: 65, right: 25, top: 40, bottom: 55 },
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        axisPointer: { type: 'line', snap: true },
        valueFormatter: (value: number | null) =>
          value === null ? 'Unscored' : formatValue(value),
      },
      xAxis: {
        ...categoryAxis(palette, 'Run (oldest → newest)', labels),
        axisLabel: {
          color: palette.muted,
          formatter: (label: string) => label.split('\n')[0]?.slice(0, 10) ?? '',
        },
      },
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

  return <ChartCard title={title} option={option} />;
};

export { AnalyticsChart };
