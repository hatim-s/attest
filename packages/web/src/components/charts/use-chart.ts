import { useEffect, useRef, type RefObject } from 'react';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption } from 'echarts/core';
import type { XAXisComponentOption, YAXisComponentOption } from 'echarts';
import { CanvasRenderer } from 'echarts/renderers';

use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

type ChartPalette = Record<
  'accent' | 'border' | 'danger' | 'muted' | 'text' | 'warning' | 'series-1' | 'surface',
  string
>;

/** Shares category-axis styling while callers supply labels and optional tick formatting. */
const categoryAxis = (
  palette: ChartPalette,
  name: string,
  data: string[],
): XAXisComponentOption => ({
  type: 'category',
  name,
  data,
  nameLocation: 'middle',
  nameGap: 32,
  nameTextStyle: { color: palette.muted },
  axisLabel: { color: palette.muted, fontSize: 10 },
  axisLine: { lineStyle: { color: palette.border } },
});

/** Keeps numeric axes legible against either dashboard theme. */
const valueAxis = (palette: ChartPalette, name: string): YAXisComponentOption => ({
  type: 'value',
  name,
  nameLocation: 'middle',
  nameGap: 45,
  nameTextStyle: { color: palette.muted },
  axisLabel: { color: palette.muted, fontSize: 10 },
  axisLine: { lineStyle: { color: palette.border } },
  splitLine: { lineStyle: { color: palette.border } },
});

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
      chart.setOption(optionRef.current(readPalette())),
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
    chartRef.current?.setOption(createOption(readPalette()));
  }, [createOption]);
};

export { useChart, categoryAxis, valueAxis, type ChartPalette };
