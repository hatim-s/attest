import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EvalSummary } from '@attest/core/records';
import type { DashboardSource } from '../../api/dashboard-source.js';
import { evalSlicesQueryOptions } from '../../api/queries/evals.js';
import { PassRateTrend } from '../../components/charts/compact/pass-rate-trend.js';
import { TREND_LIMIT, type TrendAxis } from '../../components/charts/compact/trend-model.js';
import { useTargetHref } from '../frame/use-target-href.js';
import { ChartGhost } from './chart-ghost.js';

type PassRatePanelProps = {
  source: DashboardSource;
  projectKey: string;
  evals: readonly EvalSummary[];
  /** The eval on the chart; undefined only when the project has no evals. */
  selected: string | undefined;
  onSelect: (suiteName: string) => void;
  since: string;
  rangeName: string;
};

/** One eval's slices in the period. The trend owns the line, rail and readout. */
const EvalTrend = ({
  source,
  projectKey,
  suiteName,
  since,
  rangeName,
}: Pick<PassRatePanelProps, 'source' | 'projectKey' | 'since' | 'rangeName'> & {
  suiteName: string;
}) => {
  const [axis, setAxis] = useState<TrendAxis>('date');
  const hrefFor = useTargetHref();

  const slices = useQuery(
    evalSlicesQueryOptions(source, projectKey, suiteName, { since, limit: TREND_LIMIT }),
  );

  if (slices.data === undefined)
    return <ChartGhost>{slices.error?.message ?? `Loading runs of ${suiteName}...`}</ChartGhost>;

  if (slices.data.items.length === 0)
    return (
      <ChartGhost>
        No runs of {suiteName} in the last {rangeName}.
      </ChartGhost>
    );

  return (
    <>
      <PassRateTrend
        key={JSON.stringify([source.id, projectKey, suiteName, since])}
        runs={slices.data.items}
        axis={axis}
        onAxisChange={setAxis}
        label={suiteName}
        runHref={(slice) =>
          hrefFor({
            kind: 'run',
            sourceId: source.id,
            projectKey,
            evalId: suiteName,
            runId: slice.runId,
          })
        }
      />
      {slices.data.nextCursor !== undefined && (
        <p className="attest-panel-note">
          Showing the newest {TREND_LIMIT} runs of the last {rangeName}.
        </p>
      )}
    </>
  );
};

/** Pass rate for one eval at a time, picked with the tabs in the panel header. */
const PassRatePanel = ({ evals, selected, onSelect, ...trend }: PassRatePanelProps) => (
  <section className="attest-panel" aria-label="Pass rate">
    <div className="attest-panel-h">
      <h2>Pass rate</h2>
      {evals.length > 1 ? (
        <div className="attest-evsw" role="group" aria-label="Eval in the pass-rate chart">
          {evals.map(({ suiteName }) => (
            <button
              type="button"
              key={suiteName}
              aria-pressed={suiteName === selected}
              onClick={() => onSelect(suiteName)}
            >
              {suiteName}
            </button>
          ))}
        </div>
      ) : (
        selected !== undefined && <span className="attest-dim">{selected}</span>
      )}
    </div>
    <div className="attest-panel-b">
      {selected === undefined ? (
        <ChartGhost>Each eval gets a pass-rate line here after its first run.</ChartGhost>
      ) : (
        <EvalTrend {...trend} suiteName={selected} />
      )}
    </div>
  </section>
);

export { PassRatePanel };
