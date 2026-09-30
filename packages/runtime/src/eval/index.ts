export { executeResolvedEvalPlan, freezeEvalRun } from './engine/index.js';
export { createEvalJUnitPayload } from './junit.js';
export { classifyCaseVerdict, normalizeCaseResult, summarizeEvalCases } from './normalization.js';
export type {
  DeepReadonly,
  EvalArtifactWriter,
  EvalBaselineAdapter,
  EvalCaseExecutionContext,
  EvalCaseInfrastructureFailure,
  EvalCaseRecord,
  EvalCaseRunner,
  EvalCaseRunnerResult,
  EvalCaseVerdict,
  EvalEventLimits,
  EvalExecutionResult,
  EvalJUnitPayload,
  EvalPersistenceAdapter,
  EvalTerminalErrorCode,
  EvalTerminalFailureFactory,
  ExecuteEvalOptions,
  ImmutableEvalRun,
  NormalizedEvalCaseResult,
  ResolvedEvalCase,
  ResolvedEvalPlan,
} from './types.js';
export {
  type EvalHooks,
  type EvalHookContexts,
  type EvalCaseHookContext,
  type EvalRunHookContext,
} from './hooks.js';
export {
  createStagedCaseRunner,
  EvalCaseStageError,
  type CaseStageContext,
  type EvalCaseStage,
  type StagedCaseRunnerOptions,
} from './staged-runner.js';
