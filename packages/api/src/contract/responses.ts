import { z } from 'zod';
import {
  runPageSchema,
  runRecordSchema,
  caseSummaryPageSchema,
  caseRecordSchema,
  runDiffSchema,
} from '@attest/core/records';
import type { CaseSummary, RunRecord } from '@attest/core/records';
import { aggregateCases, caseAggregateSchema, suiteAggregateSchema } from '@attest/core/analytics';
import type { ApiRoute } from './routes.js';

const runSuitesSchema = z.object({
  runId: z.string().min(1),
  suites: z.array(suiteAggregateSchema),
});

const suiteHistoryPointSchema = z.object({
  runId: z.string().min(1),
  createdAt: z.string(),
  status: runRecordSchema.shape.status,
  gitBranch: z.string().optional(),
  gitSha: z.string().optional(),
  aggregate: caseAggregateSchema,
});

type SuiteHistoryPoint = z.infer<typeof suiteHistoryPointSchema>;

/** Keeps live and snapshot history points consistent as their contract evolves. */
const toSuiteHistoryPoint = (
  run: RunRecord,
  summaries: readonly CaseSummary[],
  suiteName: string,
): SuiteHistoryPoint | undefined => {
  const [first, ...rest] = summaries.filter((summary) => summary.suiteName === suiteName);

  if (first === undefined) return undefined;

  return {
    runId: run.id,
    createdAt: run.createdAt,
    status: run.status,
    gitBranch: run.gitBranch,
    gitSha: run.gitSha,
    aggregate: aggregateCases([first, ...rest]),
  };
};

const suiteHistorySchema = z.object({
  suiteName: z.string().min(1),
  exhausted: z.boolean(),
  runsExamined: z.number().int().nonnegative(),
  points: z.array(suiteHistoryPointSchema),
});

type RunSuites = z.infer<typeof runSuitesSchema>;

type SuiteHistory = z.infer<typeof suiteHistorySchema>;

const apiResponses = {
  listRunSuites: runSuitesSchema,
  getSuiteHistory: suiteHistorySchema,
  listRuns: runPageSchema,
  getRun: runRecordSchema,
  listCaseSummaries: caseSummaryPageSchema,
  getCase: caseRecordSchema,
  getDiff: runDiffSchema,
} as const satisfies Record<ApiRoute, z.ZodType>;

export {
  apiResponses,
  runSuitesSchema,
  suiteHistoryPointSchema,
  toSuiteHistoryPoint,
  suiteHistorySchema,
  type RunSuites,
  type SuiteHistory,
};
