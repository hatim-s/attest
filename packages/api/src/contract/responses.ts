import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import {
  runPageSchema,
  runRecordSchema,
  caseSummaryPageSchema,
  caseRecordSchema,
  runDiffSchema,
  projectRecordSchema,
  runCancelOutcomeSchema,
  testSummarySchema,
} from '@attest/core/records';
import type { CaseSummary, RunRecord } from '@attest/core/records';
import { aggregateCases, caseAggregateSchema, suiteAggregateSchema } from '@attest/core/analytics';
import type { ApiRoute } from './routes.js';

const projectListSchema = stripStruct({ items: Schema.Array(projectRecordSchema) });

const testListSchema = stripStruct({ items: Schema.Array(testSummarySchema) });

const runStartResponseSchema = stripStruct({ runId: Schema.String.check(Schema.isMinLength(1)) });

const runCancelResponseSchema = stripStruct({ outcome: runCancelOutcomeSchema });

const runSuitesSchema = stripStruct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  suites: Schema.Array(suiteAggregateSchema),
});

const suiteHistoryPointSchema = stripStruct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  createdAt: Schema.String,
  status: Schema.Union([
    runRecordSchema.members[0].from.schema.fields.status,
    runRecordSchema.members[1].from.schema.fields.status,
  ]),
  gitBranch: Schema.optional(Schema.String),
  gitSha: Schema.optional(Schema.String),
  aggregate: caseAggregateSchema,
});

type SuiteHistoryPoint = typeof suiteHistoryPointSchema.Type;

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

const suiteHistorySchema = stripStruct({
  suiteName: Schema.String.check(Schema.isMinLength(1)),
  exhausted: Schema.Boolean,
  runsExamined: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  points: Schema.Array(suiteHistoryPointSchema),
});

type ProjectList = typeof projectListSchema.Type;

type TestList = typeof testListSchema.Type;

type RunStartResponse = typeof runStartResponseSchema.Type;

type RunCancelResponse = typeof runCancelResponseSchema.Type;

type RunSuites = typeof runSuitesSchema.Type;

type SuiteHistory = typeof suiteHistorySchema.Type;

const apiResponses = {
  listProjects: projectListSchema,
  listRunSuites: runSuitesSchema,
  getSuiteHistory: suiteHistorySchema,
  listRuns: runPageSchema,
  getRun: runRecordSchema,
  listCaseSummaries: caseSummaryPageSchema,
  getCase: caseRecordSchema,
  getDiff: runDiffSchema,
  listTests: testListSchema,
  startRun: runStartResponseSchema,
  cancelRun: runCancelResponseSchema,
} as const satisfies Record<ApiRoute, Schema.ConstraintDecoder<unknown>>;

export {
  apiResponses,
  projectListSchema,
  projectRecordSchema,
  runSuitesSchema,
  suiteHistoryPointSchema,
  toSuiteHistoryPoint,
  suiteHistorySchema,
  testListSchema,
  runStartResponseSchema,
  runCancelResponseSchema,
  type ProjectList,
  type RunSuites,
  type SuiteHistory,
  type TestList,
  type RunStartResponse,
  type RunCancelResponse,
};
