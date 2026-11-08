export { apiRoutes, buildPath, type ApiRoute, type PathParams } from './routes.js';

export {
  projectParamsSchema,
  runParamsSchema,
  caseParamsSchema,
  diffParamsSchema,
  pageQuerySchema,
  evalParamsSchema,
  caseHistoryParamsSchema,
  caseSummariesQuerySchema,
  evalRunsQuerySchema,
  activityQuerySchema,
  runStartRequestSchema,
  type CaseSummariesQuery,
  type EvalRunsQuery,
  type ActivityQuery,
} from './requests.js';

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
} from './responses.js';

export {
  projectOverviewEntrySchema,
  projectOverviewListSchema,
  type ProjectOverviewEntry,
  type ProjectOverviewList,
} from './overview.js';

export {
  API_ERROR_CODES,
  apiErrorCodeSchema,
  apiErrorEnvelopeSchema,
  API_ERROR_STATUS,
  type ApiErrorCode,
  type ApiErrorEnvelope,
} from './errors.js';

export { reportSnapshotSchema, type ReportSnapshot } from './snapshot.js';

export {
  apiCapabilitiesSchema,
  dashboardBootstrapSchema,
  type ApiCapabilities,
  type DashboardBootstrap,
} from './bootstrap.js';
