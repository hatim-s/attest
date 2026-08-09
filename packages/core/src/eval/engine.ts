import {
  CLI_EVENT_SCHEMA_VERSION,
  CLI_RESULT_SCHEMA_VERSION,
  type CliError,
  type EvalEvent,
  type EvalFinalResultData,
  type EvalRunSummary,
} from '@attest/contracts';

import { createEvalJUnitPayload } from './junit.js';
import { normalizeCaseResult, summarizeEvalCases } from './normalization.js';
import type {
  EvalCaseInfrastructureFailure,
  EvalCaseRecord,
  EvalCaseRunner,
  EvalEventLimits,
  EvalExecutionResult,
  EvalPersistenceAdapter,
  EvalTerminalFailureFactory,
  ExecuteEvalOptions,
  ImmutableEvalRun,
  ResolvedEvalCase,
  ResolvedEvalPlan,
} from './types.js';

const DEFAULT_EVENT_LIMITS: EvalEventLimits = {
  max_events: 100_003,
  max_event_bytes: 16 * 1024,
};
const MINIMUM_EVENT_BYTES = 1024;
const EMPTY_SUMMARY: EvalRunSummary = {
  total_cases: 0,
  passed_cases: 0,
  failed_cases: 0,
  error_cases: 0,
  metric_error_count: 0,
};

/** Recursively freezes cloned JSON metadata so adapters cannot mutate the run snapshot after creation. */
const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

/** Produces an owned immutable copy of resolver-supplied eval-run metadata. */
const freezeEvalRun = (run: ResolvedEvalPlan['run']): ImmutableEvalRun =>
  deepFreeze(structuredClone(run));

/** Converts hostile thrown values to bounded, non-sensitive infrastructure diagnostics. */
const safeErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  return message.length <= 512 ? message : `${message.slice(0, 509)}...`;
};

/** Verifies that the opaque cases still match the frozen snapshot and its configured order exactly. */
const validateResolvedPlan = (
  plan: ResolvedEvalPlan,
  run: ImmutableEvalRun,
): string | undefined => {
  const selectedCases = run.snapshot.selected_cases;
  if (selectedCases.length !== plan.cases.length) {
    return 'Resolved case count does not match the immutable eval snapshot.';
  }
  for (let index = 0; index < plan.cases.length; index += 1) {
    const resolvedCase = plan.cases[index];
    const selectedCase = selectedCases[index];
    if (
      resolvedCase === undefined ||
      selectedCase === undefined ||
      resolvedCase.configured_index !== index ||
      selectedCase.configured_index !== index ||
      resolvedCase.test_id !== selectedCase.test_id ||
      resolvedCase.case_id !== selectedCase.case_id ||
      JSON.stringify(resolvedCase.source) !== JSON.stringify(selectedCase.source)
    ) {
      return `Resolved case at configured index ${String(index)} drifted from the immutable eval snapshot.`;
    }
    if (
      resolvedCase.test_concurrency !== undefined &&
      (!Number.isInteger(resolvedCase.test_concurrency) || resolvedCase.test_concurrency < 1)
    ) {
      return `Resolved test concurrency at configured index ${String(index)} must be a positive integer.`;
    }
  }
  return undefined;
};

/** Preflights the largest case events so byte caps fail before a run or adapter is touched. */
const eventBytesFit = (
  plan: ResolvedEvalPlan,
  run: ImmutableEvalRun,
  limits: EvalEventLimits,
  terminalFailure: EvalTerminalFailureFactory,
): boolean => {
  const envelopeBytes = (event: Omit<EvalEvent, 'schema' | 'sequence' | 'time'>): number =>
    Buffer.byteLength(
      JSON.stringify({
        schema: CLI_EVENT_SCHEMA_VERSION,
        sequence: plan.cases.length * 2 + 2,
        time: run.created_at,
        ...event,
      }),
      'utf8',
    );

  const maximumSummary: EvalRunSummary = {
    total_cases: plan.cases.length,
    passed_cases: 0,
    failed_cases: plan.cases.length,
    error_cases: 0,
    metric_error_count: plan.cases.length,
  };
  const fixedEventsFit = [
    {
      event: 'run_started' as const,
      data: {
        run_id: run.run_id,
        snapshot_hash: run.snapshot_hash,
        total_cases: plan.cases.length,
        concurrency: run.effective_command.resolved.concurrency,
        timeout_ms: run.effective_command.resolved.timeout_ms,
      },
    },
    {
      event: 'run_completed' as const,
      data: { run_id: run.run_id, status: 'completed' as const, summary: maximumSummary },
    },
    { event: 'result' as const, data: completedResult(run, maximumSummary) },
    {
      event: 'result' as const,
      data: terminalFailure('run_failed', 'Eval run encountered an error.'),
    },
  ].every((event) => envelopeBytes(event) <= limits.max_event_bytes);

  return (
    fixedEventsFit &&
    plan.cases.every((resolvedCase) => {
      const shared = {
        run_id: run.run_id,
        test_id: resolvedCase.test_id,
        case_id: resolvedCase.case_id,
        configured_index: resolvedCase.configured_index,
      };
      return (
        envelopeBytes({ event: 'case_started', data: shared }) <= limits.max_event_bytes &&
        envelopeBytes({
          event: 'case_completed',
          data: {
            ...shared,
            completion_index: plan.cases.length,
            outcome: 'invocation_error',
            verdict: 'error',
          },
        }) <= limits.max_event_bytes
      );
    })
  );
};

/** Resolves and validates finite event limits before any persistence or runner activity. */
const resolveEventLimits = (options: {
  event_limits?: Partial<EvalEventLimits>;
}): EvalEventLimits => {
  const limits = { ...DEFAULT_EVENT_LIMITS, ...options.event_limits };
  if (!Number.isInteger(limits.max_events) || limits.max_events < 1) {
    throw new TypeError('Eval max_events must be a positive integer.');
  }
  if (!Number.isInteger(limits.max_event_bytes) || limits.max_event_bytes < MINIMUM_EVENT_BYTES) {
    throw new TypeError(
      `Eval max_event_bytes must be an integer of at least ${MINIMUM_EVENT_BYTES}.`,
    );
  }
  return limits;
};

/** Builds the shared failure envelope without leaking raw adapter evidence. */
const defaultTerminalFailure: EvalTerminalFailureFactory = (code, message) => ({
  exit_code: code === 'cancelled' ? 130 : 4,
  result: {
    schema: CLI_RESULT_SCHEMA_VERSION,
    ok: false,
    command: 'eval.run',
    error: { code, message, retryable: true },
  },
});

/** Builds the completed pass/fail envelope shared by JSON and the final JSONL event. */
const completedResult = (run: ImmutableEvalRun, summary: EvalRunSummary): EvalFinalResultData => {
  const verdict = summary.failed_cases === 0 ? 'pass' : 'fail';
  const sharedResult = {
    schema: CLI_RESULT_SCHEMA_VERSION,
    ok: true as const,
    command: 'eval.run' as const,
    project_hash_before: run.snapshot.project_hash,
    project_hash_after: run.snapshot.project_hash,
    warnings: [],
  };
  const payload = {
    run_id: run.run_id,
    snapshot_hash: run.snapshot_hash,
    status: 'completed' as const,
    summary,
    ...(run.effective_command.resolved.baseline_run_id === undefined
      ? {}
      : { baseline_run_id: run.effective_command.resolved.baseline_run_id }),
    ...(run.effective_command.resolved.junit_path === undefined
      ? {}
      : { junit_path: run.effective_command.resolved.junit_path }),
  };
  return verdict === 'pass'
    ? {
        exit_code: 0,
        result: { ...sharedResult, result: { ...payload, verdict: 'pass' } },
      }
    : {
        exit_code: 1,
        result: { ...sharedResult, result: { ...payload, verdict: 'fail' } },
      };
};

/** Creates a contract-shaped result-only response for failures before orchestration starts. */
const preOrchestrationFailure = async <Payload, BaselineDiff>(
  run: ImmutableEvalRun,
  now: () => string,
  finalResult: EvalFinalResultData,
  onEvent: ExecuteEvalOptions['onEvent'],
): Promise<EvalExecutionResult<Payload, BaselineDiff>> => {
  const event: EvalEvent = {
    schema: CLI_EVENT_SCHEMA_VERSION,
    sequence: 0,
    time: now(),
    event: 'result',
    data: finalResult,
  };
  try {
    await onEvent?.(event);
  } catch {
    // The primary failure remains authoritative when its one result-event sink also fails.
  }
  return {
    run,
    status: finalResult.exit_code === 130 ? 'cancelled' : 'failed',
    exit_code: finalResult.exit_code as 4 | 130,
    summary: EMPTY_SUMMARY,
    cases: [],
    events: [event],
    final_result: finalResult,
    can_release_cancellation_ownership: true,
  };
};

/** Provides one event collector that reserves final-result ownership inside the engine. */
const createEventCollector = (
  now: () => string,
  limits: EvalEventLimits,
  onEvent: ExecuteEvalOptions['onEvent'],
): {
  events: EvalEvent[];
  emit: (event: Omit<EvalEvent, 'schema' | 'sequence' | 'time'>) => Promise<void>;
  sinkFailure: () => CliError | undefined;
} => {
  const events: EvalEvent[] = [];
  let deliveryFailure: CliError | undefined;
  const emit = async (event: Omit<EvalEvent, 'schema' | 'sequence' | 'time'>): Promise<void> => {
    if (events.length >= limits.max_events) throw new Error('Eval event count cap was exceeded.');
    const completeEvent = {
      schema: CLI_EVENT_SCHEMA_VERSION,
      sequence: events.length,
      time: now(),
      ...event,
    } as EvalEvent;
    if (Buffer.byteLength(JSON.stringify(completeEvent), 'utf8') > limits.max_event_bytes) {
      throw new Error('Eval event byte cap was exceeded.');
    }
    events.push(completeEvent);
    if (onEvent !== undefined && deliveryFailure === undefined) {
      try {
        await onEvent(completeEvent);
      } catch (error: unknown) {
        deliveryFailure = {
          code: 'eval_event_delivery_failed',
          message: safeErrorMessage(error, 'Eval event delivery failed.'),
          retryable: false,
        };
      }
    }
  };
  return { events, emit, sinkFailure: () => deliveryFailure };
};

type SettledCase<Payload> = {
  resolvedCase: ResolvedEvalCase<Payload>;
  result:
    | { status: 'fulfilled'; value: Awaited<ReturnType<EvalCaseRunner<Payload>['executeCase']>> }
    | { status: 'rejected'; reason: unknown };
};

/** Runs the bounded pool while yielding exact promise-completion order. */
const executeCases = async <Payload>(
  run: ImmutableEvalRun,
  cases: readonly ResolvedEvalCase<Payload>[],
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  signal: AbortSignal,
  emit: ReturnType<typeof createEventCollector>['emit'],
): Promise<{ records: EvalCaseRecord<Payload>[]; infrastructureErrors: string[] }> => {
  const concurrency = run.effective_command.resolved.concurrency;
  const pending = new Map<number, Promise<SettledCase<Payload>>>();
  const activeByTest = new Map<string, number>();
  const records: EvalCaseRecord<Payload>[] = [];
  const infrastructureErrors: string[] = [];
  let nextIndex = 0;

  const schedule = async (): Promise<void> => {
    while (pending.size < concurrency && nextIndex < cases.length) {
      const resolvedCase = cases[nextIndex] as ResolvedEvalCase<Payload>;
      const testConcurrency = resolvedCase.test_concurrency ?? concurrency;
      const activeForTest = activeByTest.get(resolvedCase.test_id) ?? 0;
      // Case-start order is a frozen event-contract guarantee, so a saturated test pauses
      // later configured cases until one of its own active cases has drained.
      if (activeForTest >= testConcurrency) break;
      nextIndex += 1;
      await emit({
        event: 'case_started',
        data: {
          run_id: run.run_id,
          test_id: resolvedCase.test_id,
          case_id: resolvedCase.case_id,
          configured_index: resolvedCase.configured_index,
        },
      });
      const task = runner.executeCase(run.run_id, resolvedCase, signal).then(
        (value): SettledCase<Payload> => ({
          resolvedCase,
          result: { status: 'fulfilled', value },
        }),
        (reason: unknown): SettledCase<Payload> => ({
          resolvedCase,
          result: { status: 'rejected', reason },
        }),
      );
      pending.set(resolvedCase.configured_index, task);
      activeByTest.set(resolvedCase.test_id, activeForTest + 1);
    }
  };

  await schedule();
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.resolvedCase.configured_index);
    const activeForTest = activeByTest.get(settled.resolvedCase.test_id) ?? 1;
    if (activeForTest <= 1) activeByTest.delete(settled.resolvedCase.test_id);
    else activeByTest.set(settled.resolvedCase.test_id, activeForTest - 1);
    const completionIndex = records.length;
    let record: EvalCaseRecord<Payload>;

    if (
      settled.result.status === 'fulfilled' &&
      settled.result.value.execution.caseId === settled.resolvedCase.case_id
    ) {
      const { execution, metrics } = settled.result.value;
      record = {
        kind: 'executed',
        resolved_case: settled.resolvedCase,
        execution,
        metrics,
        normalized: normalizeCaseResult(settled.resolvedCase, execution, metrics, completionIndex),
      };
    } else {
      const cancellation = signal.aborted;
      const reason =
        settled.result.status === 'rejected'
          ? settled.result.reason
          : new Error(
              `Runner case id ${settled.result.value.execution.caseId} does not match ${settled.resolvedCase.case_id}.`,
            );
      const error: EvalCaseInfrastructureFailure = {
        code: 'eval_case_runner_failed',
        message: safeErrorMessage(reason, 'Eval case runner failed.'),
      };
      infrastructureErrors.push(error.message);
      record = {
        kind: 'infrastructure_error',
        resolved_case: settled.resolvedCase,
        error,
        normalized: {
          test_id: settled.resolvedCase.test_id,
          case_id: settled.resolvedCase.case_id,
          configured_index: settled.resolvedCase.configured_index,
          completion_index: completionIndex,
          outcome: cancellation ? 'cancelled' : 'invocation_error',
          verdict: 'error',
          started_at: run.created_at,
          duration_ms: 0,
          attempts: [],
          metric_results: [],
        },
      };
    }

    records.push(record);
    try {
      await persistence.recordCase(run.run_id, record);
    } catch (error: unknown) {
      infrastructureErrors.push(safeErrorMessage(error, 'Eval case persistence failed.'));
    }
    await emit({
      event: 'case_completed',
      data: {
        run_id: run.run_id,
        test_id: record.normalized.test_id,
        case_id: record.normalized.case_id,
        configured_index: record.normalized.configured_index,
        completion_index: record.normalized.completion_index,
        outcome: record.normalized.outcome,
        verdict: record.normalized.verdict,
      },
    });
    await schedule();
  }

  return { records, infrastructureErrors };
};

/**
 * Executes an already-resolved eval plan, persists its evidence, and returns one bounded event stream.
 * This is the sole dispatcher-independent orchestration entry point; discovery and CLI parsing stay out.
 */
const executeResolvedEvalPlan = async <Payload, BaselineDiff = unknown>(
  plan: ResolvedEvalPlan<Payload>,
  runner: EvalCaseRunner<Payload>,
  persistence: EvalPersistenceAdapter<Payload>,
  options: ExecuteEvalOptions<BaselineDiff> = {},
): Promise<EvalExecutionResult<Payload, BaselineDiff>> => {
  const run = freezeEvalRun(plan.run);
  const now = options.now ?? (() => new Date().toISOString());
  const limits = resolveEventLimits(options);
  const terminalFailure = options.terminalFailure ?? defaultTerminalFailure;
  const expectedEventCount = plan.cases.length * 2 + 3;
  const planError = validateResolvedPlan(plan, run);
  const eventLimitExceeded =
    expectedEventCount > limits.max_events || !eventBytesFit(plan, run, limits, terminalFailure);
  if (planError !== undefined || eventLimitExceeded) {
    return preOrchestrationFailure(
      run,
      now,
      terminalFailure(
        'run_failed',
        planError ?? 'Resolved eval plan exceeds the configured event count cap.',
      ),
      options.onEvent,
    );
  }
  if (options.signal?.aborted === true) {
    return preOrchestrationFailure(
      run,
      now,
      terminalFailure('cancelled', 'Eval run was cancelled before orchestration started.'),
      options.onEvent,
    );
  }

  try {
    await persistence.createRun(run);
  } catch (error: unknown) {
    return preOrchestrationFailure(
      run,
      now,
      terminalFailure('run_failed', safeErrorMessage(error, 'Eval run creation failed.')),
      options.onEvent,
    );
  }

  const collector = createEventCollector(now, limits, options.onEvent);
  const runController = new AbortController();
  const timeoutReason = new Error('Eval run deadline exceeded.');
  let timedOut = false;
  let callerCancelled = false;
  const onCallerAbort = (): void => {
    callerCancelled = true;
    runController.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    runController.abort(timeoutReason);
  }, run.effective_command.resolved.timeout_ms);

  let records: EvalCaseRecord<Payload>[] = [];
  const infrastructureErrors: string[] = [];
  let baselineDiff: BaselineDiff | undefined;
  let junit: ReturnType<typeof createEvalJUnitPayload> | undefined;
  let cleanupConfirmed = true;

  await collector.emit({
    event: 'run_started',
    data: {
      run_id: run.run_id,
      snapshot_hash: run.snapshot_hash,
      total_cases: plan.cases.length,
      concurrency: run.effective_command.resolved.concurrency,
      timeout_ms: run.effective_command.resolved.timeout_ms,
    },
  });

  try {
    const execution = await executeCases(
      run,
      plan.cases,
      runner,
      persistence,
      runController.signal,
      collector.emit,
    );
    records = execution.records;
    infrastructureErrors.push(...execution.infrastructureErrors);
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'Eval orchestration failed.'));
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onCallerAbort);
    try {
      await runner.cleanup?.(run.run_id);
    } catch (error: unknown) {
      cleanupConfirmed = false;
      infrastructureErrors.push(safeErrorMessage(error, 'Eval runner cleanup failed.'));
    }
  }

  const normalizedCases = records.map(({ normalized }) => normalized);
  const summary = summarizeEvalCases(normalizedCases);
  const hasCancelledCase = normalizedCases.some(({ outcome }) => outcome === 'cancelled');
  const hasCaseInfrastructureError = normalizedCases.some(({ verdict }) => verdict === 'error');
  let status: EvalExecutionResult['status'] =
    callerCancelled || (!timedOut && hasCancelledCase) ? 'cancelled' : 'completed';

  if (status === 'completed' && (timedOut || hasCaseInfrastructureError)) status = 'failed';
  if (status === 'completed' && infrastructureErrors.length === 0) {
    const baselineRunId = run.effective_command.resolved.baseline_run_id;
    if (baselineRunId !== undefined) {
      try {
        if (options.baseline === undefined) throw new Error('Baseline adapter is not configured.');
        baselineDiff = await options.baseline.diffRuns({
          baselineRunId,
          candidateRunId: run.run_id,
        });
      } catch (error: unknown) {
        infrastructureErrors.push(safeErrorMessage(error, 'Baseline diff failed.'));
      }
    }

    const junitPath = run.effective_command.resolved.junit_path;
    if (junitPath !== undefined && infrastructureErrors.length === 0) {
      try {
        if (options.artifacts === undefined)
          throw new Error('JUnit artifact writer is not configured.');
        junit = createEvalJUnitPayload(run.run_id, normalizedCases);
        await options.artifacts.writeJUnitAtomically(junitPath, junit);
      } catch (error: unknown) {
        infrastructureErrors.push(safeErrorMessage(error, 'JUnit publication failed.'));
      }
    }
  }

  if (collector.sinkFailure() !== undefined) {
    infrastructureErrors.push(collector.sinkFailure()!.message);
  }
  // A cancellation is not successful while its runner may still own live child processes.
  if (!cleanupConfirmed) status = 'failed';
  if (status === 'completed' && infrastructureErrors.length > 0) status = 'failed';

  let finalizationConfirmed = false;
  try {
    await persistence.finalizeRun(run.run_id, status, summary);
    finalizationConfirmed = true;
  } catch (error: unknown) {
    infrastructureErrors.push(safeErrorMessage(error, 'Eval run finalization failed.'));
    status = 'failed';
    // Reconcile a transient or status-specific failure before releasing the live-run registry.
    try {
      await persistence.finalizeRun(run.run_id, 'failed', summary);
      finalizationConfirmed = true;
    } catch (retryError: unknown) {
      infrastructureErrors.push(
        safeErrorMessage(retryError, 'Eval run failure reconciliation failed.'),
      );
    }
  }

  const finalResult =
    status === 'completed'
      ? completedResult(run, summary)
      : status === 'cancelled'
        ? terminalFailure('cancelled', 'Eval run was cancelled.')
        : terminalFailure(
            'run_failed',
            timedOut
              ? 'Eval run deadline exceeded.'
              : 'Eval run encountered an invocation, metric, persistence, or artifact error.',
          );

  await collector.emit({ event: 'run_completed', data: { run_id: run.run_id, status, summary } });
  await collector.emit({ event: 'result', data: finalResult });

  return {
    run,
    status,
    exit_code: finalResult.exit_code as 0 | 1 | 4 | 130,
    summary,
    cases: records,
    events: collector.events,
    final_result: finalResult,
    can_release_cancellation_ownership: cleanupConfirmed && finalizationConfirmed,
    ...(baselineDiff === undefined ? {} : { baseline_diff: baselineDiff }),
    ...(junit === undefined ? {} : { junit }),
  };
};

export { executeResolvedEvalPlan, freezeEvalRun };
