/** Public core runtime APIs (PLAN Phase 1): run store + run diffing. */
export {
  BUNDLE_VERSION,
  StoreError,
  exportRunBundle,
  openRunStore,
  openStore,
  readRunBundle,
  type AttestStore,
  type BundleCase,
  type BundleFooter,
  type BundleHeader,
  type BundleLine,
  type BundleManifest,
  type CacheKind,
  type CacheStore,
  type CaseOutcome,
  type CaseRecord,
  type CaseSummary,
  type InvocationError,
  type RunMetadata,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type RunSummary,
  type StoredAttempt,
  type StoredCaseExecution,
  type StoredDiagnostics,
  type StoredInvocationErrorCode,
  type StoredMetricEvaluation,
} from './store/index.js';
export {
  DiffConfigError,
  classifyRuns,
  classifyTransition,
  computeCaseVerdict,
  computeMetricDeltas,
  diffRuns,
  diffToJson,
  evaluateThresholds,
  runToJUnitXml,
  type CaseTransition,
  type CaseTransitionKind,
  type CaseVerdict,
  type CiVerdict,
  type DiffSummary,
  type MetricDelta,
  type RunDiff,
  type ThresholdConfig,
} from './diff/index.js';
export {
  AttestMetricError,
  type AttestMetricErrorCode,
  type AttestMetricErrorOptions,
} from './metrics/errors.js';
export {
  buildEvaluationDocument,
  resolveDocumentPath,
  type EvaluationDocument,
  type PathResolution,
} from './metrics/evaluation-document.js';
export {
  evaluateAssertionCheck,
  evaluateAssertionMetric,
  type AssertionCheckOutcome,
  type AssertionMetricDefinition,
  type AssertionMetricOutcome,
} from './metrics/assertion-engine.js';
export type {
  MetricContext,
  MetricErrorInfo,
  MetricEvaluation,
  MetricExecutionView,
} from './metrics/metric-evaluation.js';
export {
  executeExecutableMetric,
  type ExecutableMetricDefinition,
  type ExecuteMetricOptions,
} from './metrics/exec-metric.js';
export { evaluateMetrics, type EvaluateMetricsOptions } from './metrics/evaluate-metrics.js';
export type {
  JudgeAttempt,
  JudgeCallOptions,
  JudgeClient,
  JudgeOutcome,
  JudgeRecord,
  JudgeRequest,
  JudgeUsage,
  JudgeVerdict,
} from './metrics/judge/judge-client.js';
export {
  computeJudgeCacheKey,
  type JudgeCache,
  type JudgeCacheEntry,
} from './metrics/judge/judge-cache.js';
export {
  evaluateJudgeMetric,
  type EvaluateJudgeMetricOptions,
  type JudgeMetricDefinition,
} from './metrics/judge/judge-metric.js';
export {
  createTanstackJudgeClient,
  type TanstackJudgeClientOptions,
} from './metrics/judge/tanstack-judge-client.js';
export {
  fromStoredMetricEvaluation,
  toStoredMetricEvaluation,
} from './metrics/stored-metric-evaluation.js';
