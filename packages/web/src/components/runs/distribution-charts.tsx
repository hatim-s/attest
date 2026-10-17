import { useCallback, useMemo } from 'react';

import type { EChartsCoreOption } from 'echarts/core';
import { ChartCard } from '../charts/chart-card.js';
import { categoryAxis, valueAxis, type ChartPalette } from '../charts/use-chart.js';

import { aggregateCases } from '@attest/core/analytics';
import type { CaseSummary } from '@attest/core/records';

type DistributionChartsProps = {
  cases: CaseSummary[];
  isLoading: boolean;
  totalCases: number;
};

type ScoreBin = {
  count: number;
  label: string;
};

const SCORE_LABELS = ['0–0.2', '0.2–0.4', '0.4–0.6', '0.6–0.8', '0.8–1.0'];

/** Buckets average case scores into fifths. Cases without a numeric score are skipped. */
const createScoreHistogram = (cases: CaseSummary[]): ScoreBin[] => {
  const counts = SCORE_LABELS.map(() => 0);

  for (const { score } of cases) {
    if (score === undefined || !Number.isFinite(score)) continue;
    const normalized = Math.max(0, Math.min(1, score));
    const index = Math.min(counts.length - 1, Math.floor(normalized * counts.length));
    counts[index]! += 1;
  }

  return SCORE_LABELS.map((label, index) => ({ count: counts[index]!, label }));
};

/** Renders the score histogram and verdict pie for the loaded cases. */
const DistributionCharts = ({ cases, isLoading, totalCases }: DistributionChartsProps) => {
  const histogram = useMemo(() => createScoreHistogram(cases), [cases]);

  const verdicts = useMemo(() => {
    const [first, ...rest] = cases;

    return first === undefined
      ? { pass: 0, fail: 0, error: 0 }
      : aggregateCases([first, ...rest]).verdicts;
  }, [cases]);

  const scoreOption = useCallback(
    (palette: ChartPalette): EChartsCoreOption => ({
      grid: { left: 55, right: 16, top: 35, bottom: 55 },
      tooltip: { trigger: 'item', renderMode: 'richText' },
      xAxis: categoryAxis(
        palette,
        'Mean score',
        histogram.map(({ label }) => label),
      ),
      yAxis: { ...valueAxis(palette, 'Cases'), minInterval: 1 },
      series: [
        {
          data: histogram.map(({ count }) => count),
          itemStyle: { borderRadius: [4, 4, 0, 0], color: palette['series-1'] },
          barMaxWidth: 24,
          name: 'Cases',
          type: 'bar',
        },
      ],
    }),
    [histogram],
  );

  const verdictOption = useCallback(
    ({ accent, danger, muted, text, warning }: ChartPalette): EChartsCoreOption => ({
      legend: { bottom: 2, textStyle: { color: muted, fontSize: 10 } },
      series: [
        {
          center: ['50%', '43%'],
          data: [
            { name: 'Pass', value: verdicts.pass, itemStyle: { color: accent } },
            { name: 'Fail', value: verdicts.fail, itemStyle: { color: danger } },
            { name: 'Error', value: verdicts.error, itemStyle: { color: warning } },
          ].filter(({ value }) => value > 0),
          label: { color: text, formatter: '{d}%', fontSize: 11 },
          radius: ['46%', '70%'],
          type: 'pie',
        },
      ],
      tooltip: { trigger: 'item', renderMode: 'richText' },
    }),
    [verdicts],
  );

  return (
    <section className="distribution-panel" aria-label="Run distributions">
      <div className="distribution-heading">
        <div>
          <p className="eyebrow">Run distributions</p>
          <h3>Scores and verdicts</h3>
        </div>
        <span>
          {cases.length} of {totalCases} cases loaded{isLoading ? '…' : ''}
        </span>
      </div>
      <div className="chart-grid">
        <ChartCard
          title="Average metric score"
          detail={`${cases.filter(({ score }) => score !== undefined).length} scored cases`}
          option={scoreOption}
          table={
            <table className="analytics-table">
              <caption>Score histogram</caption>
              <thead>
                <tr>
                  <th scope="col">Score</th>
                  <th scope="col">Cases</th>
                </tr>
              </thead>
              <tbody>
                {histogram.map((bin) => (
                  <tr key={bin.label}>
                    <th scope="row">{bin.label}</th>
                    <td>{bin.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
        <ChartCard
          title="Case pass rate"
          detail="Mutually exclusive final verdicts"
          option={verdictOption}
          table={
            <table className="analytics-table">
              <caption>Final verdict counts</caption>
              <thead>
                <tr>
                  <th scope="col">Verdict</th>
                  <th scope="col">Cases</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(verdicts).map(([verdict, count]) => (
                  <tr key={verdict}>
                    <th scope="row">{verdict}</th>
                    <td>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
      </div>
    </section>
  );
};

export { DistributionCharts, createScoreHistogram, type DistributionChartsProps, type ScoreBin };
