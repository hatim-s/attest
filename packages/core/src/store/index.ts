export {
  BUNDLE_SCHEMA_ID,
  createBundle,
  createContentHasher,
  verifyBundleLines,
  type BundleLine,
  type BundleManifest,
} from './bundle-format.js';

export {
  computeCaseVerdict,
  summarizeCaseRecord,
  summarizeVerdicts,
  type CaseVerdictEvidence,
  type MetricVerdictEvidence,
} from './case-summary.js';

export { type CacheKind, type CacheStore } from './cache.js';

export { canonicalStringify, contentHash } from './internal/canonical-json.js';

export { parseRecord } from './internal/record-validation.js';

export { StoreError, type StoreErrorCode } from './store-error.js';

export { createSingleProjectCatalog } from './single-project-catalog.js';

export {
  type AttestStore,
  type CaseRecord,
  type CaseSummary,
  type CaseVerdict,
  type RunMetadata,
  type ProjectCatalog,
  type ProjectRecord,
  type RunIdentity,
  type RunRecord,
  type RunStatus,
  type RunSummary,
  type RunSource,
  type RunStore,
  type StoredCaseExecution,
  type StoredMetricEvaluation,
  type StoredAttempt,
} from './types.js';

export {
  caseRecordSchema,
  runRecordSchema,
  storedCaseExecutionSchema,
  storedMetricEvaluationSchema,
} from './internal/record-schema.js';

export {
  pageQuerySchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type PageQuery,
  type RunPage,
  type CaseSummaryPage,
} from '../records/page-schemas.js';

export { projectKeySchema, projectRecordSchema } from '../records/project-schemas.js';
