import * as Schema from 'effect/Schema';
import { stripStruct } from '@attest/contracts';

/** ISO evidence timestamps allow offsets and arbitrary fractional precision without rounding bytes. */
const indexedTimestampSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const match =
        /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
          value,
        );

      if (!match) return false;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

      return (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= days[month - 1]! &&
        Number.isFinite(Date.parse(value))
      );
    },
    { message: 'must be an ISO timestamp' },
  ),
);

const count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const sliceTotalsSchema = stripStruct({
  planned: Schema.NullOr(count),
  recorded: count,
  passed: count,
  failed: count,
  errored: count,
  skipped: count,
  metricErrors: count,
  scored: count,
  scoreSum: Schema.Finite,
});

const runStatusSchema = Schema.Literals(['running', 'completed', 'failed', 'cancelled']);

const sliceBase = {
  runId: Schema.String,
  suiteName: Schema.String,
  createdAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  runStatus: runStatusSchema,
  gitBranch: Schema.NullOr(Schema.String),
  gitSha: Schema.NullOr(Schema.String),
  counts: stripStruct({ ...sliceTotalsSchema.from.schema.fields, notRun: Schema.NullOr(count) }),
  meanScore: Schema.NullOr(Schema.Finite),
};

const evalSliceSchema = Schema.Union([
  stripStruct({
    ...sliceBase,
    state: Schema.Literal('complete'),
    passRate: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  stripStruct({
    ...sliceBase,
    state: Schema.Literals(['running', 'incomplete']),
    passRate: Schema.Null,
  }),
]);

const evalSummarySchema = stripStruct({
  suiteName: Schema.String,
  latest: evalSliceSchema,
  latestComplete: Schema.NullOr(evalSliceSchema),
  latestTerminal: Schema.NullOr(evalSliceSchema),
  failing: Schema.NullOr(Schema.Boolean),
});

const evalPageSchema = stripStruct({
  items: Schema.Array(evalSummarySchema),
  nextCursor: Schema.optional(Schema.String),
});

const projectRunOverviewSchema = stripStruct({
  evals: evalPageSchema,
  runningRunCount: count,
  runningRunCountTruncated: Schema.Boolean,
  lastRunAt: Schema.NullOr(Schema.String),
});

const evalRunPageSchema = stripStruct({
  items: Schema.Array(evalSliceSchema),
  nextCursor: Schema.optional(Schema.String),
});

const historyCellSchema = stripStruct({
  runId: Schema.String,
  createdAt: Schema.String,
  runStatus: runStatusSchema,
  cell: Schema.Literals(['pass', 'fail', 'error', 'skipped']),
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

const caseHistoryPageSchema = stripStruct({
  items: Schema.Array(historyCellSchema),
  nextCursor: Schema.optional(Schema.String),
});

const evalCaseWindowSchema = stripStruct({
  runs: Schema.Array(evalSliceSchema),
  items: Schema.Array(
    stripStruct({
      caseId: Schema.String,
      cells: Schema.Array(Schema.NullOr(historyCellSchema.from.schema.fields.cell)),
    }),
  ),
  nextCursor: Schema.optional(Schema.String),
});

const activityDaySchema = stripStruct({
  day: Schema.String,
  slices: count,
  passed: count,
  failed: count,
  errored: count,
  skipped: count,
});

const activitySchema = stripStruct({
  coveredFrom: Schema.String,
  coveredTo: Schema.String,
  timezone: Schema.Literal('UTC'),
  days: Schema.Array(activityDaySchema),
  truncated: Schema.Boolean,
});

type SliceTotals = typeof sliceTotalsSchema.Type;

type EvalSlice = typeof evalSliceSchema.Type;

type EvalSummary = typeof evalSummarySchema.Type;

type ProjectRunOverview = typeof projectRunOverviewSchema.Type;

type EvalPage = typeof evalPageSchema.Type;

type EvalRunPage = typeof evalRunPageSchema.Type;

type CaseHistoryPage = typeof caseHistoryPageSchema.Type;

type EvalCaseWindow = typeof evalCaseWindowSchema.Type;

type Activity = typeof activitySchema.Type;

export {
  indexedTimestampSchema,
  sliceTotalsSchema,
  evalSliceSchema,
  evalSummarySchema,
  evalPageSchema,
  projectRunOverviewSchema,
  evalRunPageSchema,
  caseHistoryPageSchema,
  evalCaseWindowSchema,
  activitySchema,
  type SliceTotals,
  type EvalSlice,
  type EvalPage,
  type EvalSummary,
  type ProjectRunOverview,
  type EvalRunPage,
  type CaseHistoryPage,
  type EvalCaseWindow,
  type Activity,
};
