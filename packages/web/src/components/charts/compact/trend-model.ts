import type { EvalSlice } from '@attest/core/records';

type TrendAxis = 'run' | 'date';

const TREND_LIMIT = 200;

/**
 * Orders at most 200 eval slices from one source-aware window, breaking timestamp ties by run id.
 * Only a complete slice carries a pass rate (the slice union enforces it), so running and
 * incomplete slices get `rate: null` and sit on the rail instead of joining the line. Rates
 * compare against the previous complete slice only.
 */
function prepareTrend(runs: readonly EvalSlice[], axis: TrendAxis) {
  if (runs.length > TREND_LIMIT) throw new RangeError(`Trend window exceeds ${TREND_LIMIT} slices`);

  const visible = runs
    .map((run) => ({ run, startedAt: Date.parse(run.createdAt) }))
    .sort((a, b) => a.startedAt - b.startedAt || a.run.runId.localeCompare(b.run.runId, 'en'));

  const first = visible[0]?.startedAt ?? 0;
  const last = visible.at(-1)?.startedAt ?? first;
  let previous: { run: EvalSlice; rate: number } | undefined;

  return visible.map(({ run, startedAt }, index) => {
    const rate = run.passRate;

    const comparison =
      rate !== null && previous
        ? {
            previousId: previous.run.runId,
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
          : (startedAt - first) / (last - first)
        : visible.length > 1
          ? index / (visible.length - 1)
          : 0.5;

    return { run, startedAt, rate, comparison, x };
  });
}

export { prepareTrend, TREND_LIMIT, type TrendAxis };
