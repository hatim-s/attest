import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import type { CaseSummary } from '../records/projection-schemas.js';

const count = Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0));

const caseAggregateSchema = stripStruct({
  caseCount: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
  verdicts: stripStruct({ pass: count, fail: count, error: count }),
  passRate: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  scoredCaseCount: count,
  meanScore: Schema.NullOr(Schema.Finite),
  durationMs: stripStruct({
    p50: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    p95: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  metricErrorCount: count,
});

const suiteAggregateSchema = stripStruct({
  ...caseAggregateSchema.from.schema.fields,
  suiteName: Schema.String.check(Schema.isMinLength(1)),
});

type CaseAggregate = typeof caseAggregateSchema.Type;

type SuiteAggregate = typeof suiteAggregateSchema.Type;

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
    .sort((a, b) => (a.suiteName < b.suiteName ? -1 : a.suiteName > b.suiteName ? 1 : 0));
};

export {
  aggregateCases,
  summarizeSuites,
  caseAggregateSchema,
  suiteAggregateSchema,
  type CaseAggregate,
  type SuiteAggregate,
};
