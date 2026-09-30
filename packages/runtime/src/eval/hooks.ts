import type { EvalRunSummary } from '@attest/contracts';
import type { CaseEnvironment, CaseEnvironmentFactory, CaseExecution } from '@attest/executor';

import type { StoredMetricEvaluation } from '@attest/core';
import { EvalCaseStageError } from './staged-runner.js';
import type { EvalCaseRunner, ImmutableEvalRun, ResolvedEvalCase } from './types.js';

type EvalRunHookContext = {
  run: ImmutableEvalRun;
  signal: AbortSignal;
  /** Shared run state. Hooks that write here must coordinate concurrent cases themselves. */
  state: Map<string, unknown>;
};
type EvalCaseHookContext<Payload> = EvalRunHookContext & {
  resolvedCase: ResolvedEvalCase<Payload>;
  worker_index: number;
  /** A fresh map per case, retained through its final hook. */
  caseState: Map<string, unknown>;
  environment?: CaseEnvironment;
};
type EvalHookContexts<Payload> = {
  before_run: EvalRunHookContext;
  before_case: EvalCaseHookContext<Payload>;
  after_agent: EvalCaseHookContext<Payload> & { execution: CaseExecution };
  after_evaluation: EvalCaseHookContext<Payload> & {
    execution: CaseExecution;
    metrics: readonly StoredMetricEvaluation[];
  };
  after_case: EvalCaseHookContext<Payload> & {
    result?: Awaited<ReturnType<EvalCaseRunner<Payload>['executeCase']>>;
    error?: unknown;
  };
  after_run: EvalRunHookContext & {
    status: 'completed' | 'failed' | 'cancelled';
    summary: EvalRunSummary;
  };
};
type EvalHooks<Payload = unknown> = {
  [Stage in keyof EvalHookContexts<Payload>]?: (
    context: EvalHookContexts<Payload>[Stage],
  ) => void | Promise<void>;
};

const LIFECYCLE_ERROR_LIMIT = 4096;
const TRUNCATED_SUFFIX = ' [truncated]';

/** Propagates cleanup uncertainty through final-hook aggregates. */
const cleanupUncertain = (error: unknown): boolean =>
  error instanceof Error &&
  (('cleanupConfirmed' in error && error.cleanupConfirmed === false) ||
    (error instanceof AggregateError && error.errors.some(cleanupUncertain)) ||
    ('cause' in error && cleanupUncertain(error.cause)));

/** Flattens nested lifecycle failures into stable diagnostics without discarding earlier evidence. */
const lifecycleErrorMessages = (error: unknown, fallback: string): string[] => {
  if (error instanceof AggregateError) {
    const messages = error.errors.flatMap((nested) => lifecycleErrorMessages(nested, fallback));
    return messages.length === 0 ? [fallback] : messages;
  }
  return [error instanceof Error ? error.message : fallback];
};

/** Bounds persisted diagnostics while leaving room for an explicit truncation marker. */
const boundedLifecycleError = (messages: readonly string[]): string => {
  const uniqueMessages = [...new Set(messages)];
  const message = uniqueMessages.join(' ');
  if (message.length <= LIFECYCLE_ERROR_LIMIT) return message;
  const contentLimit = LIFECYCLE_ERROR_LIMIT - TRUNCATED_SUFFIX.length;
  const separatorLength = Math.max(0, uniqueMessages.length - 1);
  const contentBudget = Math.max(0, contentLimit - separatorLength);
  let minimum = 0;
  let maximum = contentBudget;
  while (minimum < maximum) {
    const candidate = Math.ceil((minimum + maximum) / 2);
    const used = uniqueMessages.reduce(
      (total, entry) => total + Math.min(entry.length, candidate),
      0,
    );
    if (used <= contentBudget) minimum = candidate;
    else maximum = candidate - 1;
  }
  const lengths = uniqueMessages.map((entry) => Math.min(entry.length, minimum));
  let remaining = contentBudget - lengths.reduce((total, length) => total + length, 0);
  for (const [index, entry] of uniqueMessages.entries()) {
    const extra = Math.min(remaining, entry.length - lengths[index]!);
    lengths[index]! += extra;
    remaining -= extra;
  }
  const compacted = uniqueMessages.map((entry, index) => entry.slice(0, lengths[index])).join(' ');
  return `${compacted.slice(0, contentLimit)}${TRUNCATED_SUFFIX}`;
};

/** Returns fresh evidence objects with every lifecycle failure represented in diagnostics. */
const withLifecycleFailures = <Payload>(
  result: Awaited<ReturnType<EvalCaseRunner<Payload>['executeCase']>>,
  failures: readonly unknown[],
) => {
  const messages = [
    result.execution.diagnostics.lifecycleError,
    result.lifecycle_error,
    ...failures.flatMap((failure) =>
      lifecycleErrorMessages(failure, 'Eval case lifecycle failed.'),
    ),
  ].filter((message): message is string => message !== undefined && message.length > 0);
  const lifecycleError = boundedLifecycleError(messages);
  return {
    execution: {
      ...result.execution,
      diagnostics: {
        ...result.execution.diagnostics,
        ...(lifecycleError.length === 0 ? {} : { lifecycleError }),
      },
    },
    metrics: [...result.metrics],
    ...(lifecycleError.length === 0 ? {} : { lifecycle_error: lifecycleError }),
  };
};

/** Composes ordered, awaited hooks without sharing mutable case state between workers. */
const withEvalHooks = <Payload>(
  run: ImmutableEvalRun,
  runner: EvalCaseRunner<Payload>,
  hooks: readonly EvalHooks<Payload>[],
  isolation?: CaseEnvironmentFactory,
): EvalCaseRunner<Payload> => {
  const state = new Map<string, unknown>();
  const cleanupFailures: unknown[] = [];
  let runSignal = new AbortController().signal;
  const latchCleanupFailure = (error: unknown, force = false): void => {
    if (force || cleanupUncertain(error)) cleanupFailures.push(error);
  };
  const dispatch = async <Stage extends keyof EvalHookContexts<Payload>>(
    stage: Stage,
    context: EvalHookContexts<Payload>[Stage],
    settle = false,
  ): Promise<void> => {
    const errors: unknown[] = [];
    for (const hook of hooks) {
      try {
        await hook[stage]?.(context);
      } catch (error) {
        if (!settle) throw error;
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Eval ${stage} hooks failed.`);
  };
  return {
    beforeRun: async (runId, signal) => {
      runSignal = signal;
      try {
        await dispatch('before_run', { run, signal, state });
        await runner.beforeRun?.(runId, signal);
      } catch (error: unknown) {
        latchCleanupFailure(error);
        throw error;
      }
    },
    executeCase: async (runId, resolvedCase, signal, worker) => {
      const context: EvalCaseHookContext<Payload> = {
        run,
        signal,
        state,
        resolvedCase,
        ...worker,
        caseState: new Map<string, unknown>(),
      };
      let result: Awaited<ReturnType<EvalCaseRunner<Payload>['executeCase']>> | undefined;
      let caseFailure: unknown;
      const fatalFailures: unknown[] = [];
      const lifecycleFailures: unknown[] = [];
      try {
        context.environment = await isolation?.({
          runId,
          caseId: resolvedCase.case_id,
          testId: resolvedCase.test_id,
          configuredIndex: resolvedCase.configured_index,
          workerIndex: worker.worker_index,
          signal,
        });
        await dispatch('before_case', context);
        result = await runner.executeCase(runId, resolvedCase, signal, {
          ...worker,
          environment: context.environment,
          afterAgent: (execution) => dispatch('after_agent', { ...context, execution }),
          afterEvaluation: (execution, metrics) =>
            dispatch('after_evaluation', { ...context, execution, metrics }),
        });
      } catch (error: unknown) {
        latchCleanupFailure(error);
        if (error instanceof EvalCaseStageError) {
          caseFailure = error.cause;
          lifecycleFailures.push(error.cause);
          result = { execution: error.execution, metrics: error.metrics };
        } else {
          caseFailure = error;
          fatalFailures.push(error);
        }
      }

      try {
        await context.environment?.beginFinalization?.();
      } catch (error: unknown) {
        latchCleanupFailure(error);
        lifecycleFailures.push(error);
        if (result === undefined) fatalFailures.push(error);
      }

      try {
        const resultForHook =
          result === undefined ? undefined : withLifecycleFailures(result, lifecycleFailures);
        await dispatch(
          'after_case',
          {
            ...context,
            result: resultForHook,
            ...(caseFailure === undefined ? {} : { error: caseFailure }),
          },
          true,
        );
      } catch (error: unknown) {
        latchCleanupFailure(error);
        lifecycleFailures.push(error);
        if (result === undefined) fatalFailures.push(error);
      } finally {
        try {
          await context.environment?.dispose();
        } catch (error: unknown) {
          latchCleanupFailure(error, true);
          lifecycleFailures.push(error);
          if (result === undefined) fatalFailures.push(error);
        }
      }

      if (result !== undefined) return withLifecycleFailures(result, lifecycleFailures);
      if (fatalFailures.length === 1) throw fatalFailures[0];
      if (fatalFailures.length > 1) {
        throw new AggregateError(fatalFailures, 'Eval case lifecycle failed.');
      }
      throw new Error('Eval runner returned no case result.');
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
      } catch (error) {
        errors.push(error);
      }
      try {
        await dispatch('after_run', { run, signal: runSignal, state, status, summary }, true);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0)
        throw Object.assign(new AggregateError(errors, 'Eval after_run hooks failed.'), {
          cleanupConfirmed: !errors.some(cleanupUncertain),
        });
    },
  };
};

export {
  withEvalHooks,
  type EvalHooks,
  type EvalHookContexts,
  type EvalRunHookContext,
  type EvalCaseHookContext,
};
