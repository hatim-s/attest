import type { ReactNode } from 'react';

/** A chart frame with nothing to plot, as tall as the chart it stands in for. */
const ChartGhost = ({ children }: { children: ReactNode }) => (
  <div className="attest-chart-ghost">
    <p role="status">{children}</p>
  </div>
);

export { ChartGhost };
