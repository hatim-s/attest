import { useCallback, useMemo } from 'react';
import type { CaseSummary } from '@attest/core/records';
import type { EChartsCoreOption } from 'echarts/core';
import { createDurationHistogram } from './loaded-analytics.js';
import { ChartCard } from '../charts/chart-card.js';
import { categoryAxis, valueAxis, type ChartPalette } from '../charts/use-chart.js';

/** Keeps durations in milliseconds so equal-width bars represent equal elapsed intervals. */
const DurationDistribution = ({ cases }: { cases: CaseSummary[] }) => {
  const bins = useMemo(() => createDurationHistogram(cases), [cases]);

  const labels = useMemo(
    () =>
      bins.map(
        (bin, index) =>
          `${bin.lowerMs} to ${bin.upperMs}${index === bins.length - 1 ? ' inclusive' : ' exclusive'}`,
      ),
    [bins],
  );

  const option = useCallback(
    (palette: ChartPalette): EChartsCoreOption => ({
      grid: { left: 55, right: 20, top: 45, bottom: 70 },
      legend: { top: 0, textStyle: { color: palette.text } },
      tooltip: { trigger: 'item', renderMode: 'richText' },
      xAxis: {
        ...categoryAxis(palette, 'Duration (ms)', labels),
        nameGap: 48,
        axisLabel: {
          color: palette.muted,
          rotate: 25,
          formatter: (label: string) => label.replace(' inclusive', '').replace(' exclusive', ''),
        },
      },
      yAxis: { ...valueAxis(palette, 'Cases'), minInterval: 1 },
      series: (
        [
          { verdict: 'pass', name: '✓ Pass', color: palette.accent },
          { verdict: 'fail', name: '× Fail', color: palette.danger },
          { verdict: 'error', name: '! Error', color: palette.warning },
        ] as const
      ).map(({ verdict, name, color }) => ({
        type: 'bar',
        name,
        stack: 'verdict',
        barMaxWidth: 24,
        data: bins.map((bin) => bin.counts[verdict]),
        itemStyle: {
          color,
          borderColor: palette.surface,
          borderWidth: 2,
          borderRadius: [4, 4, 0, 0],
        },
      })),
    }),
    [bins, labels],
  );

  return (
    <ChartCard
      title="Case durations by verdict"
      option={option}
      table={
        <table className="analytics-table">
          <caption>
            Milliseconds. Lower bounds inclusive; upper bounds exclusive except the final bin.
          </caption>
          <thead>
            <tr>
              <th scope="col">Duration</th>
              <th scope="col">✓ Pass</th>
              <th scope="col">× Fail</th>
              <th scope="col">! Error</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((bin, index) => (
              <tr key={bin.lowerMs}>
                <th scope="row">{labels[index]}</th>
                <td>{bin.counts.pass}</td>
                <td>{bin.counts.fail}</td>
                <td>{bin.counts.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
};

export { DurationDistribution };
