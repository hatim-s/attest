import type {
  AgentRequest,
  AgentResponse,
  CaseOutcome,
  ContractWarning,
  EvalEvent,
  EvalFinalResultData,
  EvalRun,
  EvalRunSelectedCase,
  EvalRunSummary,
  JsonValue,
  TestCase,
  Trace,
} from '@attest/contracts';

import type { EvalHooks } from './hooks.js';

import type { MetricEvaluation } from '../metrics/metric-evaluation.js';
import type {
  AgentInvocationError,
  CaseEnvironment,
  CaseEnvironmentFactory,
  InvocationAttempt,
  InvocationDiagnostics,
} from '@attest/executor';

/** Fields shared by every terminal case state; layout mirrors the store's persisted shape. */
type CaseExecutionBase = {
  caseId: string;
  suiteName: string;
  request: AgentRequest;
  /**
   * Transient full case document (including `expected`) so metrics can run
   * before persistence; the store adapter deliberately drops it.
   */
  caseDefinition: TestCase;
  /** Metric names resolved for this case (per-case override, else suite metrics). */
  expectedMetrics: string[];
  /** Every transport attempt including retries, preserved per the agent contract. */
  attempts: InvocationAttempt[];
  diagnostics: InvocationDiagnostics;
  warnings: ContractWarning[];
  startedAt: string;
  durationMs: number;
};

/**
 * Everything downstream consumers (metrics, store, reports) need about one
 * executed case, discriminated on `outcome` so completed cases provably carry
 * a response and failed ones provably carry the invocation error.
 */
type CaseExecution = CaseExecutionBase &
  (
    | { outcome: 'completed'; response: AgentResponse; trace?: Trace }
    | {
        outcome: Exclude<CaseOutcome, 'completed'>;
        invocationError: AgentInvocationError;
      }
  );

/** Recursively marks the immutable eval-run metadata handed to execution and persistence. */
type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

type ImmutableEvalRun = DeepReadonly<EvalRun>;

/** Carries one resolver-owned case payload without coupling orchestration to project discovery. */
type ResolvedEvalCase<Payload = unknown> = EvalRunSelectedCase & {
  test_concurrency?: number;
  payload: Payload;
};

/** Defines the complete, already-resolved immutable input accepted by the eval engine. */
type ResolvedEvalPlan<Payload = unknown> = {
  run: EvalRun;
  cases: readonly ResolvedEvalCase<Payload>[];
};

/** Preserves one normalized transport attempt independently from runner implementation details. */
type NormalizedEvalAttempt = {
  attempt_index: number;
  status: 'ok' | 'invocation_error';
  duration_ms: number;
  diagnostics: InvocationDiagnostics;
  warnings: CaseExecution['warnings'];
  raw_excerpt?: CaseExecution['attempts'][number]['rawExcerpt'];
  error?: { code: string; message: string };
};

/** Preserves metric failure and metric infrastructure error as distinct machine states. */
type NormalizedEvalMetricResult =
  | {
      metric_name: string;
      kind: MetricEvaluation['kind'];
      status: 'evaluated';
      score: number;
      pass: boolean;
      rationale?: string;
      details?: JsonValue;
      judge_io?: JsonValue;
      duration_ms?: number;
    }
  | {
      metric_name: string;
      kind: MetricEvaluation['kind'];
      status: 'error';
      error: { code: string; message: string; details?: JsonValue };
      rationale?: string;
      judge_io?: JsonValue;
      duration_ms?: number;
    };

type EvalCaseVerdict = 'pass' | 'fail' | 'error';

/** Provides the stable case-level projection consumed by events, JUnit, and result summaries. */
type NormalizedEvalCaseResult = {
  test_id: string;
  case_id: string;
  configured_index: number;
  completion_index: number;
  outcome: CaseExecution['outcome'];
  verdict: EvalCaseVerdict;
  started_at: string;
  duration_ms: number;
  attempts: NormalizedEvalAttempt[];
  metric_results: NormalizedEvalMetricResult[];
};

/** Captures a catastrophic per-case adapter rejection without inventing runner evidence. */
type EvalCaseInfrastructureFailure = {
  code: 'eval_case_runner_failed';
  message: string;
};

/** Retains raw runner evidence for store binding alongside the normalized result projection. */
type EvalCaseRecord<Payload = unknown> =
  | {
      kind: 'executed';
      resolved_case: ResolvedEvalCase<Payload>;
      execution: CaseExecution;
      metrics: readonly MetricEvaluation[];
      normalized: NormalizedEvalCaseResult;
    }
  | {
      kind: 'infrastructure_error';
      resolved_case: ResolvedEvalCase<Payload>;
      error: EvalCaseInfrastructureFailure;
      normalized: NormalizedEvalCaseResult;
    };

/** Runs one already-resolved case through the existing runner and metric result interfaces. */
type EvalCaseExecutionContext = {
  /** Identifies the stable worker directory or transient concurrency slot assigned to this case. */
  worker_index: number;
  environment?: CaseEnvironment;
  afterAgent?(execution: CaseExecution): Promise<void>;
  afterEvaluation?(execution: CaseExecution, metrics: readonly MetricEvaluation[]): Promise<void>;
};

type EvalCaseRunnerResult = {
  execution: CaseExecution;
  metrics: readonly MetricEvaluation[];
  lifecycle_error?: string;
};

type EvalCaseRunner<Payload = unknown> = {
  beforeRun?(runId: string, signal: AbortSignal): Promise<void>;
  executeCase(
    runId: string,
    resolvedCase: ResolvedEvalCase<Payload>,
    signal: AbortSignal,
    context: EvalCaseExecutionContext,
  ): Promise<EvalCaseRunnerResult>;
  cleanup?(runId: string): Promise<void>;
  afterRun?(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    summary: EvalRunSummary,
  ): Promise<void>;
};

/**
 * Defines the narrow persistence seam integration can bind to the existing RunStore mappings.
 * The engine never opens a database or imports the old configuration model directly.
 */
type EvalPersistenceAdapter<Payload = unknown> = {
  createRun(run: ImmutableEvalRun): Promise<void>;
  recordCase(runId: string, record: EvalCaseRecord<Payload>): Promise<void>;
  finalizeRun(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    summary: EvalRunSummary,
  ): Promise<void>;
};

/** Computes a persisted comparison after the candidate cases have been recorded. */
type EvalBaselineAdapter<BaselineDiff = JsonValue> = {
  diffRuns(input: { baselineRunId: string; candidateRunId: string }): Promise<BaselineDiff>;
};

/** Carries deterministic JUnit bytes and their integrity hash to an atomic writer. */
type EvalJUnitPayload = {
  contents: string;
  byte_length: number;
  sha256: string;
};

/** Keeps filesystem publication outside the engine while requiring atomic replacement semantics. */
type EvalArtifactWriter = {
  writeJUnitAtomically(path: string, payload: EvalJUnitPayload): Promise<void>;
};

/** Bounds the public event stream before any agent work begins. */
type EvalEventLimits = {
  max_events: number;
  max_event_bytes: number;
};

type EvalTerminalErrorCode = 'cancelled' | 'run_failed';

/** Builds a terminal eval failure from the caller's canonical public error catalog. */
type EvalTerminalFailureFactory = (
  code: EvalTerminalErrorCode,
  message: string,
) => EvalFinalResultData;

/** Injects deterministic time and optional event delivery without changing stored results. */
type ExecuteEvalOptions<BaselineDiff = JsonValue, Payload = unknown> = {
  hooks?: readonly EvalHooks<Payload>[];
  isolation?: CaseEnvironmentFactory;
  signal?: AbortSignal;
  now?: () => string;
  event_limits?: Partial<EvalEventLimits>;
  onEvent?: (event: EvalEvent) => void | Promise<void>;
  baseline?: EvalBaselineAdapter<BaselineDiff>;
  artifacts?: EvalArtifactWriter;
  terminalFailure?: EvalTerminalFailureFactory;
};

/** Returns all auditable outputs needed by the CLI adapter without performing CLI rendering. */
type EvalExecutionResult<Payload = unknown, BaselineDiff = JsonValue> = {
  run: ImmutableEvalRun;
  status: 'completed' | 'failed' | 'cancelled';
  exit_code: EvalFinalResultData['exit_code'];
  summary: EvalRunSummary;
  cases: readonly EvalCaseRecord<Payload>[];
  events: readonly EvalEvent[];
  final_result: EvalFinalResultData;
  /** Allows the CLI to remove its live-run registry only after cleanup and durability are confirmed. */
  can_release_cancellation_ownership: boolean;
  baseline_diff?: BaselineDiff;
  junit?: EvalJUnitPayload;
};

export {
  type CaseExecution,
  type CaseExecutionBase,
  type DeepReadonly,
  type EvalArtifactWriter,
  type EvalBaselineAdapter,
  type EvalCaseInfrastructureFailure,
  type EvalCaseExecutionContext,
  type EvalCaseRecord,
  type EvalCaseRunner,
  type EvalCaseRunnerResult,
  type EvalCaseVerdict,
  type EvalEventLimits,
  type EvalExecutionResult,
  type EvalJUnitPayload,
  type EvalPersistenceAdapter,
  type EvalTerminalErrorCode,
  type EvalTerminalFailureFactory,
  type ExecuteEvalOptions,
  type ImmutableEvalRun,
  type NormalizedEvalAttempt,
  type NormalizedEvalCaseResult,
  type NormalizedEvalMetricResult,
  type ResolvedEvalCase,
  type ResolvedEvalPlan,
};
