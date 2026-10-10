import type { StoredMetricEvaluation } from '@attest/core';
import type { CaseExecution } from './types.js';

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
const isCleanupUncertain = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) {
    return false;
  }

  if ('cleanupConfirmed' in cause && cause.cleanupConfirmed === false) {
    return true;
  }

  if (cause instanceof AggregateError && cause.errors.some(isCleanupUncertain)) {
    return true;
  }

  return isCleanupUncertain(cause.cause);
};

/** Bounds thrown values to short messages so infrastructure diagnostics never carry raw evidence. */
const safeErrorMessage = (cause: unknown, fallback: string): string => {
  const message = cause instanceof Error ? cause.message : fallback;

  if (message.length <= MAXIMUM_ERROR_MESSAGE_LENGTH) {
    return message;
  }

  return `${message.slice(0, MAXIMUM_ERROR_MESSAGE_LENGTH - 3)}...`;
};

export { EvalCaseStageError, isCleanupUncertain, safeErrorMessage, type EvalCaseStage };
