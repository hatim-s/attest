import type { RunStatus } from '@attest/core/records';
import type { VerdictCounts } from '../../meters/proportions.js';

type TrendRun = {
  id: string;
  /** Epoch milliseconds, mapped from the decoded API timestamp. */
  startedAt: number;
  label: string;
  runStatus: RunStatus;
  counts: VerdictCounts & { planned: number | null; recorded: number };
} & ({ state: 'complete'; passRate: number } | { state: 'running' | 'incomplete' });

type TrendAxis = 'run' | 'date';

const TREND_LIMIT = 200;

/** The complete slice uses its recorded denominator, independent of run-wide status. */
function passRate(run: TrendRun) {
  return run.state === 'complete' ? run.passRate : null;
}

/** Sort a bounded server window, resolving timestamp ties by real run identity. */
function prepareTrend(runs: readonly TrendRun[], axis: TrendAxis) {
  if (runs.length > TREND_LIMIT) throw new RangeError(`Trend window exceeds ${TREND_LIMIT} slices`);

  const visible = [...runs].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id, 'en'),
  );

  const first = visible[0]?.startedAt ?? 0;
  const last = visible.at(-1)?.startedAt ?? first;
  let previous: { run: TrendRun; rate: number } | undefined;

  return visible.map((run, index) => {
    const rate = passRate(run);

    const comparison =
      rate !== null && previous
        ? {
            previousId: previous.run.id,
            points: (rate - previous.rate) * 100,
            selectionChanged:
              run.counts.planned !== previous.run.counts.planned ||
              run.counts.recorded !== previous.run.counts.recorded,
          }
        : null;

    if (rate !== null) previous = { run, rate };

    const x =
      axis === 'date'
        ? last === first
          ? 0.5
          : (run.startedAt - first) / (last - first)
        : visible.length > 1
          ? index / (visible.length - 1)
          : 0.5;

    return { run, rate, comparison, x };
  });
}

export { passRate, prepareTrend, TREND_LIMIT, type TrendRun, type TrendAxis };
