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
  activitySchema,
  caseHistoryPageSchema,
  evalCaseWindowSchema,
  evalPageSchema,
  evalRunPageSchema,
  evalSliceSchema,
  projectRunOverviewSchema,
} from '@attest/core/records';
import type { ApiRoute } from './routes.js';
import { projectOverviewListSchema } from './overview.js';

const projectListSchema = stripStruct({ items: Schema.Array(projectRecordSchema) });

const testListSchema = stripStruct({ items: Schema.Array(testSummarySchema) });

const runStartResponseSchema = stripStruct({ runId: Schema.String.check(Schema.isMinLength(1)) });

const runCancelResponseSchema = stripStruct({ outcome: runCancelOutcomeSchema });

const runSuitesSchema = stripStruct({
  runId: Schema.String.check(Schema.isMinLength(1)),
  suites: Schema.Array(evalSliceSchema),
});

type ProjectList = typeof projectListSchema.Type;

type TestList = typeof testListSchema.Type;

type RunStartResponse = typeof runStartResponseSchema.Type;

type RunCancelResponse = typeof runCancelResponseSchema.Type;

type RunSuites = typeof runSuitesSchema.Type;

// Named with `typeof` so declaration output references each schema instead of expanding it;
// the inferred object type is too large for the compiler to serialise.
type ApiResponseSchemas = {
  readonly listOverviews: typeof projectOverviewListSchema;
  readonly listProjects: typeof projectListSchema;
  readonly getProjectOverview: typeof projectRunOverviewSchema;
  readonly listEvals: typeof evalPageSchema;
  readonly listEvalRuns: typeof evalRunPageSchema;
  readonly getEvalCaseWindow: typeof evalCaseWindowSchema;
  readonly getCaseHistory: typeof caseHistoryPageSchema;
  readonly getActivity: typeof activitySchema;
  readonly listRunSuites: typeof runSuitesSchema;
  readonly listRuns: typeof runPageSchema;
  readonly getRun: typeof runRecordSchema;
  readonly listCaseSummaries: typeof caseSummaryPageSchema;
  readonly getCase: typeof caseRecordSchema;
  readonly getDiff: typeof runDiffSchema;
  readonly listTests: typeof testListSchema;
  readonly startRun: typeof runStartResponseSchema;
  readonly cancelRun: typeof runCancelResponseSchema;
};

const apiResponses: ApiResponseSchemas = {
  listOverviews: projectOverviewListSchema,
  listProjects: projectListSchema,
  getProjectOverview: projectRunOverviewSchema,
  listEvals: evalPageSchema,
  listEvalRuns: evalRunPageSchema,
  getEvalCaseWindow: evalCaseWindowSchema,
  getCaseHistory: caseHistoryPageSchema,
  getActivity: activitySchema,
  listRunSuites: runSuitesSchema,
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
  testListSchema,
  runStartResponseSchema,
  runCancelResponseSchema,
  type ProjectList,
  type RunSuites,
  type TestList,
  type RunStartResponse,
  type RunCancelResponse,
};
