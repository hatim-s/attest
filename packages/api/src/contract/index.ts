export { apiRoutes, buildPath, type ApiRoute, type PathParams } from './routes.js';

export {
  projectParamsSchema,
  runParamsSchema,
  caseParamsSchema,
  diffParamsSchema,
  pageQuerySchema,
  suiteParamsSchema,
  suiteHistoryQuerySchema,
  suiteHistoryRequestSchema,
  runStartRequestSchema,
  MAX_SUITE_HISTORY_RUNS,
  DEFAULT_SUITE_HISTORY_RUNS,
  type SuiteHistoryQuery,
} from './requests.js';

export {
  apiResponses,
  projectListSchema,
  projectRecordSchema,
  runSuitesSchema,
  suiteHistoryPointSchema,
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
} from './responses.js';

export {
  API_ERROR_CODES,
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
