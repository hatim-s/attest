import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

import { BarChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

import { aggregateCases } from '@attest/core/analytics';
import type { CaseSummary } from '@attest/core/records';

use([BarChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type DistributionChartsProps = {
  cases: CaseSummary[];
  isLoading: boolean;
  totalCases: number;
};

type ScoreBin = {
  count: number;
  label: string;
};

type ChartPalette = Record<
  'accent' | 'border' | 'danger' | 'muted' | 'text' | 'warning' | 'series-1' | 'surface',
  string
>;

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

/** Reads chart colors from the theme variables in styles.css. */
const readPalette = (): ChartPalette => {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: keyof ChartPalette) => styles.getPropertyValue(`--${name}`).trim();

  return {
    accent: read('accent'),
    'series-1': read('series-1'),
    surface: read('surface'),
    border: read('border'),
    danger: read('danger'),
    muted: read('muted'),
    text: read('text'),
    warning: read('warning'),
  };
};

/**
 * Owns one ECharts instance. Resizes with its container and recolors when the dashboard
 * changes `data-theme` on the root element.
 */
const useChart = (
  containerRef: RefObject<HTMLDivElement | null>,
  createOption: (palette: ChartPalette) => EChartsCoreOption,
): void => {
  const chartRef = useRef<ReturnType<typeof init> | null>(null);
  const optionRef = useRef(createOption);

  useEffect(() => {
    const container = containerRef.current;

    if (container === null) return;
    const chart = init(container);
    chartRef.current = chart;
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);

    const themeObserver = new MutationObserver(() =>
      chart.setOption(optionRef.current(readPalette()), true),
    );

    themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] });

    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
      chartRef.current = null;
      chart.dispose();
    };
  }, [containerRef]);

  useEffect(() => {
    optionRef.current = createOption;
    chartRef.current?.setOption(createOption(readPalette()), true);
  }, [createOption]);
};

/** Renders the score histogram and verdict pie for the loaded cases. */
const DistributionCharts = ({ cases, isLoading, totalCases }: DistributionChartsProps) => {
  const scoreChartRef = useRef<HTMLDivElement>(null);
  const verdictChartRef = useRef<HTMLDivElement>(null);
  const histogram = useMemo(() => createScoreHistogram(cases), [cases]);

  const verdicts = useMemo(() => {
    const [first, ...rest] = cases;

    return first === undefined
      ? { pass: 0, fail: 0, error: 0 }
      : aggregateCases([first, ...rest]).verdicts;
  }, [cases]);

  const scoreOption = useCallback(
    ({ 'series-1': seriesColor, border, muted, text }: ChartPalette): EChartsCoreOption => ({
      animationDuration: 250,
      grid: { left: 55, right: 16, top: 35, bottom: 55 },
      tooltip: { trigger: 'item', renderMode: 'richText' },
      xAxis: {
        name: 'Mean score',
        nameLocation: 'middle',
        nameGap: 30,
        nameTextStyle: { color: muted },
        axisLabel: { color: muted, fontSize: 10 },
        axisLine: { lineStyle: { color: border } },
        data: histogram.map(({ label }) => label),
        type: 'category',
      },
      yAxis: {
        barMaxWidth: 24,
        name: 'Cases',
        minInterval: 1,
        nameTextStyle: { color: muted },
        axisLabel: { color: muted, fontSize: 10, precision: 0 },
        splitLine: { lineStyle: { color: border } },
        type: 'value',
      },
      series: [
        {
          data: histogram.map(({ count }) => count),
          itemStyle: { borderRadius: [4, 4, 0, 0], color: seriesColor },
          barMaxWidth: 24,
          name: 'Cases',
          type: 'bar',
        },
      ],
      textStyle: { color: text },
    }),
    [histogram],
  );

  const verdictOption = useCallback(
    ({ accent, danger, muted, text, warning }: ChartPalette): EChartsCoreOption => ({
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
      tooltip: { trigger: 'item', renderMode: 'richText' },
    }),
    [verdicts],
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
          <details>
            <summary>Score values</summary>
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
          </details>
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
          <details>
            <summary>Verdict values</summary>
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
          </details>
        </div>
      </div>
    </section>
  );
};

export {
  DistributionCharts,
  createScoreHistogram,
  useChart,
  type ChartPalette,
  type DistributionChartsProps,
  type ScoreBin,
};
