export { executeResolvedEvalPlan, freezeEvalRun } from './engine.js';
export { createEvalJUnitPayload } from './junit.js';
export {
  classifyCaseVerdict,
  normalizeAttempts,
  normalizeCaseResult,
  normalizeMetricResults,
  summarizeEvalCases,
} from './normalization.js';
export type {
  DeepReadonly,
  EvalArtifactWriter,
  EvalBaselineAdapter,
  EvalCaseInfrastructureFailure,
  EvalCaseRecord,
  EvalCaseRunner,
  EvalCaseVerdict,
  EvalEventLimits,
  EvalExecutionResult,
  EvalJUnitPayload,
  EvalPersistenceAdapter,
  EvalTerminalErrorCode,
  EvalTerminalFailureFactory,
  ExecuteEvalOptions,
  ImmutableEvalRun,
  NormalizedEvalAttempt,
  NormalizedEvalCaseResult,
  NormalizedEvalMetricResult,
  ResolvedEvalCase,
  ResolvedEvalPlan,
} from './types.js';
