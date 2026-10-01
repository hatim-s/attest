import type { EvalRun } from '@attest/contracts';
import type { CaseEnvironmentFactory } from '@attest/executor';

import { EvalCaseStageError, isCleanupUncertain } from './errors.js';
import type {
  EvalCaseExecutionContext,
  EvalCaseHookContext,
  EvalCaseRunner,
  EvalCaseRunnerResult,
  EvalHookContexts,
  EvalHooks,
  ResolvedEvalCase,
} from './types.js';

const LIFECYCLE_ERROR_LIMIT = 4096;
const TRUNCATED_SUFFIX = ' [truncated]';

/** What the case stages produced before finalization: evidence, the stopping error, or both. */
type CaseAttempt = {
  result?: EvalCaseRunnerResult;
  error?: unknown;
  lifecycleFailures: unknown[];
};

/** Flattens nested lifecycle failures into stable diagnostics without discarding earlier evidence. */
const lifecycleErrorMessages = (error: unknown): string[] => {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.flatMap(lifecycleErrorMessages);
  }
  return [error instanceof Error ? error.message : 'Eval case lifecycle failed.'];
};

/** Joins distinct lifecycle messages within the persisted diagnostics limit. */
const boundedLifecycleError = (messages: readonly string[]): string => {
  const message = [...new Set(messages)].join(' ');
  if (message.length <= LIFECYCLE_ERROR_LIMIT) {
    return message;
  }
  return `${message.slice(0, LIFECYCLE_ERROR_LIMIT - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
};

/** Returns fresh evidence objects with every lifecycle failure represented in diagnostics. */
const withLifecycleFailures = (
  result: EvalCaseRunnerResult,
  failures: readonly unknown[],
): EvalCaseRunnerResult => {
  const existing = result.execution.diagnostics.lifecycleError;
  const messages = [
    ...(existing === undefined ? [] : [existing]),
    ...failures.flatMap(lifecycleErrorMessages),
  ].filter((message) => message.length > 0);
  const lifecycleError = messages.length === 0 ? undefined : boundedLifecycleError(messages);
  return {
    execution: {
      ...result.execution,
      diagnostics: { ...result.execution.diagnostics, lifecycleError },
    },
    metrics: [...result.metrics],
  };
};

/**
 * Wraps a runner with ordered, awaited hooks and a per-case environment. Every case reaches
 * after_case and environment disposal, even when setup or a stage hook throws.
 */
const withEvalHooks = <Payload>(
  run: Readonly<EvalRun>,
  runner: EvalCaseRunner<Payload>,
  hooks: readonly EvalHooks<Payload>[],
  isolation?: CaseEnvironmentFactory,
): EvalCaseRunner<Payload> => {
  const cleanupFailures: unknown[] = [];
  let runSignal = new AbortController().signal;

  const dispatch = async <Stage extends keyof EvalHookContexts<Payload>>(
    stage: Stage,
    context: EvalHookContexts<Payload>[Stage],
  ): Promise<void> => {
    for (const hook of hooks) {
      await hook[stage]?.(context);
    }
  };

  /** Runs every hook for a final stage even when an earlier one throws, then reports them all. */
  const dispatchSettled = async <Stage extends keyof EvalHookContexts<Payload>>(
    stage: Stage,
    context: EvalHookContexts<Payload>[Stage],
  ): Promise<void> => {
    const errors: unknown[] = [];
    for (const hook of hooks) {
      try {
        await hook[stage]?.(context);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Eval ${stage} hooks failed.`);
  };

  const latchUncertainCleanup = (error: unknown): void => {
    if (isCleanupUncertain(error)) cleanupFailures.push(error);
  };

  const runCaseStages = async (
    runId: string,
    context: EvalCaseHookContext<Payload>,
    worker: EvalCaseExecutionContext,
  ): Promise<CaseAttempt> => {
    try {
      context.environment = await isolation?.({
        runId,
        caseId: context.resolvedCase.case_id,
        testId: context.resolvedCase.test_id,
        configuredIndex: context.resolvedCase.configured_index,
        workerIndex: worker.workerIndex,
        signal: context.signal,
      });
      await dispatch('before_case', context);
      const result = await runner.executeCase(runId, context.resolvedCase, context.signal, {
        ...worker,
        environment: context.environment,
        afterAgent: (execution) => dispatch('after_agent', { ...context, execution }),
        afterEvaluation: (execution, metrics) =>
          dispatch('after_evaluation', { ...context, execution, metrics }),
      });
      return { result, lifecycleFailures: [] };
    } catch (error: unknown) {
      latchUncertainCleanup(error);
      if (error instanceof EvalCaseStageError) {
        return {
          result: { execution: error.execution, metrics: error.metrics },
          error: error.cause,
          lifecycleFailures: [error.cause],
        };
      }
      return { error, lifecycleFailures: [] };
    }
  };

  /** Moves the environment into finalization, runs after_case, and disposes; returns each failure. */
  const finalizeCase = async (
    context: EvalCaseHookContext<Payload>,
    attempt: CaseAttempt,
  ): Promise<unknown[]> => {
    const failures: unknown[] = [];
    try {
      await context.environment?.beginFinalization?.();
    } catch (error: unknown) {
      latchUncertainCleanup(error);
      failures.push(error);
    }
    try {
      await dispatchSettled('after_case', {
        ...context,
        result: attempt.result,
        error: attempt.error,
      });
    } catch (error: unknown) {
      latchUncertainCleanup(error);
      failures.push(error);
    }
    try {
      await context.environment?.dispose();
    } catch (error: unknown) {
      // A failed disposal always leaves the environment's resources unconfirmed.
      cleanupFailures.push(error);
      failures.push(error);
    }
    return failures;
  };

  return {
    beforeRun: async (runId, signal) => {
      runSignal = signal;
      try {
        await dispatch('before_run', { run, signal });
        await runner.beforeRun?.(runId, signal);
      } catch (error: unknown) {
        latchUncertainCleanup(error);
        throw error;
      }
    },
    executeCase: async (runId, resolvedCase: ResolvedEvalCase<Payload>, signal, worker) => {
      const context: EvalCaseHookContext<Payload> = {
        run,
        signal,
        resolvedCase,
        workerIndex: worker.workerIndex,
      };
      const attempt = await runCaseStages(runId, context, worker);
      const finalizationFailures = await finalizeCase(context, attempt);
      if (attempt.result !== undefined) {
        return withLifecycleFailures(attempt.result, [
          ...attempt.lifecycleFailures,
          ...finalizationFailures,
        ]);
      }
      const failures = [attempt.error, ...finalizationFailures];
      throw new AggregateError(
        failures,
        boundedLifecycleError(failures.flatMap(lifecycleErrorMessages)),
      );
    },
    cleanup: async (runId) => {
      const failures = [...cleanupFailures];
      try {
        await runner.cleanup?.(runId);
      } catch (error: unknown) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw Object.assign(new AggregateError(failures, 'Eval cleanup failed.'), {
          cleanupConfirmed: false,
        });
      }
    },
    afterRun: async (runId, status, summary) => {
      const errors: unknown[] = [];
      try {
        await runner.afterRun?.(runId, status, summary);
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        await dispatchSettled('after_run', { run, signal: runSignal, status, summary });
      } catch (error: unknown) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw Object.assign(new AggregateError(errors, 'Eval after_run hooks failed.'), {
          cleanupConfirmed: !errors.some(isCleanupUncertain),
        });
      }
    },
  };
};

export { withEvalHooks };
