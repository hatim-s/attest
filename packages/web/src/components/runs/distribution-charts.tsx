import { useEffect, useMemo, useRef, type RefObject } from 'react';

import { BarChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

import type { CaseSummary } from '../../api/types.js';

use([BarChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type DistributionChartsProps = {
  cases: CaseSummary[];
  isLoading: boolean;
  theme: 'light' | 'dark';
  totalCases: number;
};

type ScoreBin = {
  count: number;
  label: string;
};

const SCORE_LABELS = ['0–0.2', '0.2–0.4', '0.4–0.6', '0.6–0.8', '0.8–1.0'];

/** Buckets normalized average case scores while ignoring cases without numeric metric scores. */
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

/** Owns one ECharts instance and keeps it aligned with responsive container changes. */
const useChart = (
  containerRef: RefObject<HTMLDivElement | null>,
  option: EChartsCoreOption,
): void => {
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = init(container);
    chart.setOption(option);
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
    };
  }, [containerRef, option]);
};

/** Renders score and verdict distributions with only the ECharts modules used by the dashboard. */
const DistributionCharts = ({ cases, isLoading, theme, totalCases }: DistributionChartsProps) => {
  const scoreChartRef = useRef<HTMLDivElement>(null);
  const verdictChartRef = useRef<HTMLDivElement>(null);
  const histogram = useMemo(() => createScoreHistogram(cases), [cases]);
  const verdicts = useMemo(
    () => ({
      pass: cases.filter(({ verdict }) => verdict === 'pass').length,
      fail: cases.filter(({ verdict }) => verdict === 'fail').length,
      error: cases.filter(({ verdict }) => verdict === 'error').length,
    }),
    [cases],
  );
  const { accent, border, danger, muted, text, warning } =
    theme === 'dark'
      ? {
          accent: '#a9d5af',
          border: '#323a32',
          danger: '#ffaaa3',
          muted: '#9da69b',
          text: '#f2f5ef',
          warning: '#f3c66d',
        }
      : {
          accent: '#385b3f',
          border: '#dfe2da',
          danger: '#a53a35',
          muted: '#687067',
          text: '#171b16',
          warning: '#9a6814',
        };
  const scoreOption = useMemo<EChartsCoreOption>(
    () => ({
      animationDuration: 250,
      grid: { left: 38, right: 16, top: 18, bottom: 35 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        axisLabel: { color: muted, fontSize: 10 },
        axisLine: { lineStyle: { color: border } },
        data: histogram.map(({ label }) => label),
        type: 'category',
      },
      yAxis: {
        axisLabel: { color: muted, fontSize: 10, precision: 0 },
        splitLine: { lineStyle: { color: border } },
        type: 'value',
      },
      series: [
        {
          data: histogram.map(({ count }) => count),
          itemStyle: { borderRadius: [5, 5, 0, 0], color: accent },
          name: 'Cases',
          type: 'bar',
        },
      ],
      textStyle: { color: text },
    }),
    [accent, border, histogram, muted, text],
  );
  const verdictOption = useMemo<EChartsCoreOption>(
    () => ({
      animationDuration: 250,
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
    [accent, danger, muted, text, verdicts, warning],
  );

  useChart(scoreChartRef, scoreOption);
  useChart(verdictChartRef, verdictOption);

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
        <div className="chart-card">
          <div>
            <strong>Average metric score</strong>
            <span>{cases.filter(({ score }) => score !== undefined).length} scored cases</span>
          </div>
          <div
            aria-label="Average metric score histogram"
            className="chart-canvas"
            ref={scoreChartRef}
          />
        </div>
        <div className="chart-card">
          <div>
            <strong>Case pass rate</strong>
            <span>Mutually exclusive final verdicts</span>
          </div>
          <div
            aria-label="Case verdict distribution"
            className="chart-canvas"
            ref={verdictChartRef}
          />
        </div>
      </div>
    </section>
  );
};

export { DistributionCharts, createScoreHistogram, type DistributionChartsProps, type ScoreBin };
