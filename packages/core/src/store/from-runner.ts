import type { CaseExecution } from '../runner/index.js';

import type { StoredAttempt, StoredCaseExecution } from './types.js';

/** Drops transient metric input while converting runner evidence into the durable store projection. */
const toStoredCaseExecution = (execution: CaseExecution): StoredCaseExecution => {
  const base = {
    caseId: execution.caseId,
    suiteName: execution.suiteName,
    request: execution.request,
    startedAt: execution.startedAt,
    durationMs: execution.durationMs,
    warnings: execution.warnings,
    diagnostics: execution.diagnostics,
    expectedMetrics: execution.expectedMetrics,
    attempts: execution.attempts.map(toStoredAttempt),
  };

  switch (execution.outcome) {
    case 'completed':
      return {
        ...base,
        outcome: 'completed',
        response: execution.response,
        trace: execution.trace,
      };
    case 'invocation_error':
    case 'timeout':
    case 'cancelled':
      return {
        ...base,
        outcome: execution.outcome,
        errorCode: execution.invocationError.code,
        errorMessage: execution.invocationError.message,
      };
    default:
      execution satisfies never;
      throw new Error('Unhandled case execution outcome.');
  }
};

/** Retains only durable transport evidence; raw envelopes and parse reports remain runner-local. */
const toStoredAttempt = (attempt: CaseExecution['attempts'][number]): StoredAttempt => {
  const base = {
    diagnostics: attempt.diagnostics,
    durationMs: attempt.durationMs,
    rawExcerpt: attempt.rawExcerpt,
    warnings: attempt.warnings,
  };
  return attempt.status === 'ok'
    ? { ...base, status: 'ok' }
    : {
        ...base,
        status: 'invocation_error',
        errorCode: attempt.error.code,
        errorMessage: attempt.error.message,
      };
};

export { toStoredCaseExecution };
