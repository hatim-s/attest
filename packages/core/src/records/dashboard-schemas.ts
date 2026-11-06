import { z } from 'zod';

const count = z.number().int().nonnegative();

const sliceTotalsSchema = z.object({
  planned: count.nullable(),
  recorded: count,
  passed: count,
  failed: count,
  errored: count,
  skipped: count,
  metricErrors: count,
  scored: count,
  scoreSum: z.number().finite(),
});

const runStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);

const sliceBase = {
  runId: z.string(),
  suiteName: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  runStatus: runStatusSchema,
  gitBranch: z.string().nullable(),
  gitSha: z.string().nullable(),
  counts: sliceTotalsSchema.extend({ notRun: count.nullable() }),
  meanScore: z.number().nullable(),
};

const evalSliceSchema = z.discriminatedUnion('state', [
  z.object({ ...sliceBase, state: z.literal('complete'), passRate: z.number().min(0).max(1) }),
  z.object({ ...sliceBase, state: z.enum(['running', 'incomplete']), passRate: z.null() }),
]);

const evalSummarySchema = z.object({
  suiteName: z.string(),
  latest: evalSliceSchema,
  latestComplete: evalSliceSchema.nullable(),
  latestTerminal: evalSliceSchema.nullable(),
  failing: z.boolean().nullable(),
});

const evalPageSchema = z.object({
  items: z.array(evalSummarySchema),
  nextCursor: z.string().optional(),
});

const projectRunOverviewSchema = z.object({
  evals: evalPageSchema,
  runningRunCount: count,
  runningRunCountTruncated: z.boolean(),
  lastRunAt: z.string().nullable(),
});

const evalRunPageSchema = z.object({
  items: z.array(evalSliceSchema),
  nextCursor: z.string().optional(),
});

const historyCellSchema = z.object({
  runId: z.string(),
  createdAt: z.string(),
  runStatus: runStatusSchema,
  cell: z.enum(['pass', 'fail', 'error', 'skipped']),
  durationMs: z.number().nonnegative(),
});

const caseHistoryPageSchema = z.object({
  items: z.array(historyCellSchema),
  nextCursor: z.string().optional(),
});

const evalCaseWindowSchema = z.object({
  runs: z.array(evalSliceSchema),
  items: z.array(
    z.object({
      caseId: z.string(),
      cells: z.array(historyCellSchema.shape.cell.nullable()),
    }),
  ),
  nextCursor: z.string().optional(),
});

const activityDaySchema = z.object({
  day: z.string(),
  slices: count,
  passed: count,
  failed: count,
  errored: count,
  skipped: count,
});

const activitySchema = z.object({
  timezone: z.literal('UTC'),
  days: z.array(activityDaySchema),
  truncated: z.boolean(),
});

type SliceTotals = z.infer<typeof sliceTotalsSchema>;

type EvalSlice = z.infer<typeof evalSliceSchema>;

type EvalSummary = z.infer<typeof evalSummarySchema>;

type ProjectRunOverview = z.infer<typeof projectRunOverviewSchema>;

type EvalPage = z.infer<typeof evalPageSchema>;

type EvalRunPage = z.infer<typeof evalRunPageSchema>;

type CaseHistoryPage = z.infer<typeof caseHistoryPageSchema>;

type EvalCaseWindow = z.infer<typeof evalCaseWindowSchema>;

type Activity = z.infer<typeof activitySchema>;

export {
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
