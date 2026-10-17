import { useCallback, useRef } from 'react';
import { LineChart } from 'echarts/charts';
import { use, type EChartsCoreOption } from 'echarts/core';
import { useChart, type ChartPalette } from './distribution-charts.js';

use([LineChart]);

/** Shares chart anatomy so histories and loaded-run trends have identical scales and tooltips. */
const AnalyticsChart = ({
  title,
  labels,
  values,
  measure,
  formatValue,
}: {
  title: string;
  labels: string[];
  values: (number | null)[];
  measure: 'Pass rate (%)' | 'Mean score';
  formatValue: (value: number) => string;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  const option = useCallback(
    (palette: ChartPalette): EChartsCoreOption => ({
      animation: false,
      grid: { left: 65, right: 25, top: 40, bottom: 55 },
      textStyle: { color: palette.text },
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        axisPointer: { type: 'line', snap: true },
        valueFormatter: (value: number | null) =>
          value === null ? 'Unscored' : formatValue(value),
      },
      xAxis: {
        type: 'category',
        name: 'Run (oldest → newest)',
        nameLocation: 'middle',
        nameGap: 32,
        nameTextStyle: { color: palette.muted },
        data: labels,
        axisLabel: {
          color: palette.muted,
          formatter: (label: string) => label.split('\n')[0]?.slice(0, 10) ?? '',
        },
        axisLine: { lineStyle: { color: palette.border } },
      },
      yAxis: {
        type: 'value',
        name: measure,
        min: measure === 'Pass rate (%)' ? 0 : undefined,
        max: measure === 'Pass rate (%)' ? 1 : undefined,
        nameTextStyle: { color: palette.muted },
        axisLabel: { color: palette.muted, formatter: formatValue },
        splitLine: { lineStyle: { color: palette.border } },
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
    [labels, values, measure, formatValue],
  );

  useChart(ref, option);

  return (
    <div className="chart-card">
      <strong>{title}</strong>
      <div ref={ref} className="chart-canvas" role="img" aria-label={title} />
    </div>
  );
};

export { AnalyticsChart };
