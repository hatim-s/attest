import { useCallback, useMemo } from 'react';

import { ChartCard } from '../charts/chart-card.js';
import {
  categoryAxis,
  valueAxis,
  type ChartOptions,
  type ChartPalette,
} from '../charts/use-chart.js';

import { aggregateCases } from '@attest/core/analytics';
import { formatCount } from '../../lib/format.js';
import { Heading } from '../shared/ui.js';
import type { CaseSummary } from '@attest/core/records';

type DistributionChartsProps = {
  cases: CaseSummary[];
  /** False while later pages are outstanding, when zero counts say nothing about the run. */
  allLoaded: boolean;
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
const DistributionCharts = ({
  cases,
  allLoaded,
  isLoading,
  totalCases,
}: DistributionChartsProps) => {
  const histogram = useMemo(() => createScoreHistogram(cases), [cases]);
  const scoredCases = histogram.reduce((total, { count }) => total + count, 0);

  const verdicts = useMemo(() => {
    const [first, ...rest] = cases;

    return first === undefined
      ? { pass: 0, fail: 0, error: 0 }
      : aggregateCases([first, ...rest]).verdicts;
  }, [cases]);

  const scoreOption = useCallback(
    (palette: ChartPalette): ChartOptions => ({
      grid: { left: 55, right: 16, top: 35, bottom: 55 },
      tooltip: { trigger: 'item' },
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
    ({ accent, danger, muted, text, warning }: ChartPalette): ChartOptions => ({
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
      tooltip: { trigger: 'item' },
    }),
    [verdicts],
  );

  return (
    <section className="stack" aria-label="Scores and verdicts">
      <Heading
        level={2}
        eyebrow="This run"
        title="Scores and verdicts"
        meta={`${cases.length} of ${formatCount(totalCases, 'case')} loaded${isLoading ? '…' : ''}`}
      />
      <div className="chart-grid">
        <ChartCard
          title="Mean score"
          detail={formatCount(scoredCases, 'scored case')}
          emptyMessage={allLoaded && scoredCases === 0 ? 'No scored cases yet.' : undefined}
          option={scoreOption}
          table={
            <table className="analytics-table">
              <caption>Cases by mean metric score</caption>
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
          title="Verdicts"
          detail="One final verdict per case"
          emptyMessage={allLoaded && cases.length === 0 ? 'No cases have finished yet.' : undefined}
          option={verdictOption}
          table={
            <table className="analytics-table">
              <caption>Cases by final verdict</caption>
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
