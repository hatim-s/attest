import { useCallback, useMemo } from 'react';
import type { CaseSummary } from '@attest/core/records';
import { createDurationHistogram } from './loaded-analytics.js';
import { formatDurationRange } from '../../lib/format.js';
import { ChartCard } from '../charts/chart-card.js';
import {
  categoryAxis,
  valueAxis,
  type ChartOptions,
  type ChartPalette,
} from '../charts/use-chart.js';

const verdictSeries = [
  { verdict: 'pass', name: '✓ Pass' },
  { verdict: 'fail', name: '× Fail' },
  { verdict: 'error', name: '! Error' },
] as const;

type DurationBin = ReturnType<typeof createDurationHistogram>[number];

/** The last verdict with cases in a bin draws the top of its stack, so only it gets round corners. */
const topVerdict = (bin: DurationBin) =>
  [...verdictSeries].reverse().find(({ verdict }) => bin.counts[verdict] > 0)?.verdict;

/** Keeps durations in milliseconds so equal-width bars represent equal elapsed intervals. */
const DurationDistribution = ({ cases }: { cases: CaseSummary[] }) => {
  const bins = useMemo(() => createDurationHistogram(cases), [cases]);

  const labels = useMemo(
    () => bins.map((bin) => formatDurationRange(bin.lowerMs, bin.upperMs)),
    [bins],
  );

  const option = useCallback(
    (palette: ChartPalette): ChartOptions => {
      const colors = { pass: palette.accent, fail: palette.danger, error: palette.warning };

      return {
        grid: { left: 55, right: 20, top: 45, bottom: 55 },
        legend: { top: 0, textStyle: { color: palette.text } },
        tooltip: { trigger: 'item' },
        xAxis: categoryAxis(palette, 'Duration', labels),
        yAxis: { ...valueAxis(palette, 'Cases'), minInterval: 1 },
        series: verdictSeries.map(({ verdict, name }) => ({
          type: 'bar',
          name,
          stack: 'verdict',
          barMaxWidth: 24,
          data: bins.map((bin) => ({
            value: bin.counts[verdict],
            itemStyle: { borderRadius: topVerdict(bin) === verdict ? [4, 4, 0, 0] : 0 },
          })),
          itemStyle: { color: colors[verdict], borderColor: palette.surface, borderWidth: 2 },
        })),
      };
    },
    [bins, labels],
  );

  return (
    <ChartCard
      title="Case durations by verdict"
      emptyMessage={cases.length === 0 ? 'No cases have finished yet.' : undefined}
      detail="Each range includes its lower bound. The last range also includes its upper bound."
      option={option}
      table={
        <table className="analytics-table">
          <thead>
            <tr>
              <th scope="col">Duration</th>
              {verdictSeries.map(({ verdict, name }) => (
                <th key={verdict} scope="col">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bins.map((bin, index) => (
              <tr key={bin.lowerMs}>
                <th scope="row">{labels[index]}</th>
                {verdictSeries.map(({ verdict }) => (
                  <td key={verdict}>{bin.counts[verdict]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
};

export { DurationDistribution };
