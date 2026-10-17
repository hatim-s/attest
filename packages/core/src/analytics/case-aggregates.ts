import { z } from 'zod';
import type { CaseSummary } from '../records/projection-schemas.js';

const count = z.number().int().nonnegative();

const caseAggregateSchema = z.object({
  caseCount: z.number().int().positive(),
  verdicts: z.object({ pass: count, fail: count, error: count }),
  passRate: z.number().min(0).max(1),
  scoredCaseCount: count,
  meanScore: z.number().nullable(),
  durationMs: z.object({ p50: z.number().nonnegative(), p95: z.number().nonnegative() }),
  metricErrorCount: count,
});

const suiteAggregateSchema = caseAggregateSchema.extend({ suiteName: z.string().min(1) });

type CaseAggregate = z.infer<typeof caseAggregateSchema>;

type SuiteAggregate = z.infer<typeof suiteAggregateSchema>;

type NonEmpty<T> = readonly [T, ...T[]];

const nearestRank = (sorted: readonly number[], percentile: number): number => {
  const value = sorted[Math.ceil((percentile / 100) * sorted.length) - 1];

  if (value === undefined) throw new RangeError('A percentile requires at least one case.');

  return value;
};

/** Shares suite statistics across live reads and offline reports without loading case blobs. */
const aggregateCases = (cases: NonEmpty<CaseSummary>): CaseAggregate => {
  const verdicts = { pass: 0, fail: 0, error: 0 };
  let scoredCaseCount = 0;
  let scoreSum = 0;
  let metricErrorCount = 0;

  for (const summary of cases) {
    verdicts[summary.verdict] += 1;
    metricErrorCount += summary.metricCounts.errors;

    if (summary.score !== undefined) {
      scoredCaseCount += 1;
      scoreSum += summary.score;
    }
  }

  const durations = cases.map((summary) => summary.durationMs).sort((a, b) => a - b);

  return {
    caseCount: cases.length,
    verdicts,
    passRate: verdicts.pass / cases.length,
    scoredCaseCount,
    meanScore: scoredCaseCount === 0 ? null : scoreSum / scoredCaseCount,
    durationMs: { p50: nearestRank(durations, 50), p95: nearestRank(durations, 95) },
    metricErrorCount,
  };
};

/** Gives every consumer the same suite ordering regardless of source page order. */
const summarizeSuites = (cases: readonly CaseSummary[]): SuiteAggregate[] => {
  const groups = new Map<string, [CaseSummary, ...CaseSummary[]]>();

  for (const summary of cases) {
    const group = groups.get(summary.suiteName);

    if (group === undefined) groups.set(summary.suiteName, [summary]);
    else group.push(summary);
  }

  return [...groups]
    .map(([suiteName, group]) => ({ suiteName, ...aggregateCases(group) }))
    .sort((a, b) => a.suiteName.localeCompare(b.suiteName));
};

export {
  aggregateCases,
  summarizeSuites,
  caseAggregateSchema,
  suiteAggregateSchema,
  type CaseAggregate,
  type SuiteAggregate,
};
