import { useCallback, useRef } from 'react';
import { type EChartsCoreOption } from 'echarts/core';
import { useChart, categoryAxis, valueAxis, type ChartPalette } from '../charts/use-chart.js';

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
        ...categoryAxis(palette, 'Run (oldest → newest)', labels),
        axisLabel: {
          color: palette.muted,
          formatter: (label: string) => label.split('\n')[0]?.slice(0, 10) ?? '',
        },
      },
      yAxis: {
        ...valueAxis(palette, measure),
        min: measure === 'Pass rate (%)' ? 0 : undefined,
        max: measure === 'Pass rate (%)' ? 1 : undefined,
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
