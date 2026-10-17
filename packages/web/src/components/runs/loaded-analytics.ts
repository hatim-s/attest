import type { CaseSummary, RunRecord } from '@attest/core/records';

type TrendRun = Pick<RunRecord, 'id' | 'createdAt' | 'gitBranch' | 'labels' | 'summary'>;

type TrendPoint = { run: TrendRun; passRate: number };

type TrendGrouping = { kind: 'branch' } | { kind: 'label'; key: string };

/** Loaded-page trends deliberately exclude unknown denominators instead of inventing a rate. */
const createRunTrends = (runs: readonly TrendRun[], grouping: TrendGrouping) => {
  const groups = new Map<string, TrendPoint[]>();
  let missingSummary = 0;
  let emptyRuns = 0;

  for (const run of [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    if (run.summary === undefined) {
      missingSummary += 1;
      continue;
    }

    if (run.summary.totalCases === 0) {
      emptyRuns += 1;
      continue;
    }

    const name =
      grouping.kind === 'branch'
        ? (run.gitBranch ?? 'Unknown branch')
        : `${grouping.key}=${run.labels?.[grouping.key] ?? '(missing)'}`;

    const points = groups.get(name) ?? [];
    points.push({ run, passRate: run.summary.passedCases / run.summary.totalCases });
    groups.set(name, points);
  }

  return {
    groups: [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, points]) => ({ name, points })),
    missingSummary,
    emptyRuns,
  };
};

/** Equal-width bins cover the observed range and include the maximum in the last bin. */
const createDurationHistogram = (cases: readonly Pick<CaseSummary, 'durationMs' | 'verdict'>[]) => {
  if (cases.length === 0) return [];
  const maximum = cases.reduce((value, item) => Math.max(value, item.durationMs), 0);
  const width = Math.max(1, Math.ceil(maximum / 10));

  return Array.from({ length: 10 }, (_, index) => {
    const lowerMs = index * width;
    const upperMs = lowerMs + width;
    const counts = { pass: 0, fail: 0, error: 0 };

    for (const item of cases) {
      if (
        item.durationMs >= lowerMs &&
        (item.durationMs < upperMs || (index === 9 && item.durationMs === upperMs))
      )
        counts[item.verdict] += 1;
    }

    return { lowerMs, upperMs, counts };
  });
};

export { createRunTrends, createDurationHistogram };
