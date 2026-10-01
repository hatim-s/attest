import type { StoredMetricEvaluation } from '@attest/core';
import type { CaseExecution } from '@attest/executor';

const MAXIMUM_ERROR_MESSAGE_LENGTH = 512;

/** Names the awaited stage hook that stopped a case after the agent ran. */
type EvalCaseStage = 'after_agent' | 'after_evaluation';

/** Retains completed stage evidence when a lifecycle hook stops the remaining case work. */
class EvalCaseStageError extends Error {
  constructor(
    readonly stage: EvalCaseStage,
    readonly execution: CaseExecution,
    readonly metrics: readonly StoredMetricEvaluation[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `Eval ${stage} hook failed.`, { cause });
    this.name = 'EvalCaseStageError';
  }
}

/**
 * Reports whether an error, or anything it aggregates or wraps, says process cleanup was not
 * confirmed. Errors from other packages signal this through a `cleanupConfirmed: false` field.
 * Follow-up: switch to `instanceof` once executor exports its SandboxCleanupError class.
 */
const isCleanupUncertain = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  if ('cleanupConfirmed' in error && error.cleanupConfirmed === false) {
    return true;
  }
  if (error instanceof AggregateError && error.errors.some(isCleanupUncertain)) {
    return true;
  }
  return isCleanupUncertain(error.cause);
};

/** Bounds thrown values to short messages so infrastructure diagnostics never carry raw evidence. */
const safeErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  if (message.length <= MAXIMUM_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAXIMUM_ERROR_MESSAGE_LENGTH - 3)}...`;
};

export { EvalCaseStageError, isCleanupUncertain, safeErrorMessage, type EvalCaseStage };
