import { parseAgentResponse, type ContractIssue } from '@attest/contracts';

import { AgentInvocationError } from '../errors.js';
import { createRawExcerpt } from './raw-excerpt.js';
import type { InvocationAttempt, InvocationDiagnostics, InvocationResult } from '../types.js';

type InvocationAttemptFactory = (attemptIndex: number) => Promise<InvocationAttempt>;

const requireValidRetryCount = (retries: number): void => {
  if (Number.isInteger(retries) && retries >= 0) return;
  throw new TypeError('Retry count must be a non-negative integer');
};

const withAttemptEvidence = (attempt: InvocationAttempt): InvocationAttempt => {
  if (attempt.rawExcerpt !== undefined) return attempt;
  const payload = attempt.status === 'ok' ? JSON.stringify(attempt.raw) : '';
  return { ...attempt, rawExcerpt: createRawExcerpt(payload), warnings: attempt.warnings ?? [] };
};

/** Summarizes contract issues without obscuring their retry classification. */
const summarizeContractIssues = (issues: ContractIssue[]): string => {
  const summary = issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return issues.length > 3 ? `${summary}; and ${String(issues.length - 3)} more` : summary;
};

/** Validates one raw transport result inside the shared invocation retry boundary. */
const validateResponseEnvelope = (
  attempt: Extract<InvocationAttempt, { status: 'ok' }>,
): InvocationAttempt => {
  const report = parseAgentResponse(attempt.raw);
  if (report.ok) return { ...attempt, report, warnings: report.warnings };

  return {
    status: 'invocation_error',
    error: new AgentInvocationError(
      'invalid_envelope',
      `Agent response envelope is invalid: ${summarizeContractIssues(report.errors)}`,
    ),
    diagnostics: attempt.diagnostics,
    durationMs: attempt.durationMs,
    rawExcerpt: attempt.rawExcerpt,
    warnings: report.warnings,
  };
};

/** Implements the invocation-error-only retry policy from the agent contract. */
const isRetryableInvocationError = (
  error: AgentInvocationError,
  diagnostics: InvocationDiagnostics,
): boolean => {
  if (diagnostics.sandboxCompletionConfirmed === false) return false;
  if (error.code === 'cancelled') return false;
  if (error.code !== 'http_status') return true;
  return diagnostics.httpStatus !== undefined && diagnostics.httpStatus >= 500;
};

/** Runs transport attempts under the common validation, evidence, and retry rules. */
const invokeWithRetries = async (
  invokeOnce: InvocationAttemptFactory,
  retries: number,
): Promise<InvocationResult> => {
  requireValidRetryCount(retries);
  const attempts: InvocationAttempt[] = [];
  let attemptIndex = 0;
  for (;;) {
    const transportAttempt = withAttemptEvidence(await invokeOnce(attemptIndex));
    const attempt =
      transportAttempt.status === 'ok'
        ? validateResponseEnvelope(transportAttempt)
        : transportAttempt;
    attempts.push(attempt);
    if (attempt.status === 'ok') return { ...attempt, attempts };
    if (
      attemptIndex >= retries ||
      !isRetryableInvocationError(attempt.error, attempt.diagnostics)
    ) {
      return { ...attempt, attempts };
    }
    attemptIndex += 1;
  }
};

export { invokeWithRetries, isRetryableInvocationError };
export type { InvocationAttemptFactory };
