import type { StoredCaseExecution } from '@attest/core';

import type { CaseExecution } from './types.js';

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
    // Raw envelopes and parse reports stay runner-local; only durable transport evidence persists.
    attempts: execution.attempts.map((attempt) => {
      const evidence = {
        diagnostics: attempt.diagnostics,
        durationMs: attempt.durationMs,
        rawExcerpt: attempt.rawExcerpt,
        warnings: attempt.warnings,
      };
      if (attempt.status === 'ok') {
        return { ...evidence, status: 'ok' as const };
      }
      return {
        ...evidence,
        status: 'invocation_error' as const,
        errorCode: attempt.error.code,
        errorMessage: attempt.error.message,
      };
    }),
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

export { toStoredCaseExecution };
