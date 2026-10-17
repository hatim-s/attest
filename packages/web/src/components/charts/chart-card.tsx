import { useRef, type ReactNode } from 'react';
import { useChart, type ChartOption } from './use-chart.js';

/** Mounts with its data so the chart instance always has a container to bind to. */
const ChartCanvas = ({ label, option }: { label: string; option: ChartOption }) => {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, option);

  return <div ref={ref} className="chart-canvas" role="img" aria-label={label} />;
};

type ChartCardProps = {
  title: string;
  detail?: ReactNode;
  /** Shown instead of the chart when there is nothing to plot, so empty axes never pass for data. */
  emptyMessage?: string;
  option: ChartOption;
  /** Omitted when the page already shows the same values in its own table. */
  table?: ReactNode;
};

/** One titled chart with its values as a table for readers who cannot use the canvas. */
const ChartCard = ({ title, detail, emptyMessage, option, table }: ChartCardProps) => (
  <figure className="chart-card">
    <figcaption>
      <strong>{title}</strong>
      {detail !== undefined ? <span>{detail}</span> : null}
    </figcaption>
    {emptyMessage === undefined ? (
      <>
        <ChartCanvas label={title} option={option} />
        {table !== undefined ? (
          <details>
            <summary>Show values</summary>
            {table}
          </details>
        ) : null}
      </>
    ) : (
      <p className="chart-empty">{emptyMessage}</p>
    )}
  </figure>
);

export { ChartCard };
