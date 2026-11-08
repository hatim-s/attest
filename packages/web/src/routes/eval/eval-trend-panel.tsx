import type { EvalRunPage, EvalSlice } from '@attest/core/records';
import { PassRateTrend } from '../../components/charts/compact/pass-rate-trend.js';
import { TREND_LIMIT, type TrendAxis } from '../../components/charts/compact/trend-model.js';
import { formatCount } from '../../lib/format.js';

type EvalTrendPanelProps = {
  suiteName: string;
  slices: EvalRunPage;
  axis: TrendAxis;
  onAxisChange: (axis: TrendAxis) => void;
  runHref: (slice: EvalSlice) => string;
  /** The run a hovered or focused table row reads out. */
  selectedRunId: string | undefined;
};

const day = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Pass rate over every run of one eval. Complete slices make the line; running and incomplete
 * slices sit on the rail. The table below drives the readout through `selectedRunId`.
 */
const EvalTrendPanel = ({ suiteName, slices, ...trend }: EvalTrendPanelProps) => {
  const completed = slices.items.filter((slice) => slice.state === 'complete').length;
  const newest = slices.items[0];
  const oldest = slices.items.at(-1);

  return (
    <section className="attest-panel attest-trend-panel" aria-label="Pass rate">
      <div className="attest-panel-h">
        <h2>Pass rate</h2>
        {newest !== undefined && oldest !== undefined && (
          <span className="attest-dim">
            {formatCount(completed, 'completed run')} of {slices.items.length},{' '}
            {newest === oldest
              ? day(newest.createdAt)
              : `${day(oldest.createdAt)} to ${day(newest.createdAt)}`}
          </span>
        )}
      </div>
      <div className="attest-panel-b">
        <PassRateTrend runs={slices.items} label={suiteName} {...trend} />
        {slices.nextCursor !== undefined && (
          <p className="attest-panel-note">Showing the newest {TREND_LIMIT} runs.</p>
        )}
      </div>
    </section>
  );
};

export { EvalTrendPanel };
