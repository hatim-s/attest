import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Exit from 'effect/Exit';
import { stripStruct } from '@attest/contracts';
import { parseAgentResponse, type ContractIssue } from '@attest/contracts';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { AgentInvocationError } from '../errors.js';
import { createRawExcerpt } from './raw-excerpt.js';
import type { InvocationAttempt, InvocationDiagnostics, InvocationResult } from '../types.js';

/** Captures completed retries on the failed Cause without changing shared error objects. */
class InvocationPriorAttempts extends Context.Service<
  InvocationPriorAttempts,
  readonly InvocationAttempt[]
>()('attest/InvocationPriorAttempts') {}

/** Inspects native retry evidence; this receipt is not a transport or persisted field. */
const getInvocationPriorAttempts = <E>(cause: Cause.Cause<E>): readonly InvocationAttempt[] =>
  Context.getOrUndefined(Cause.annotations(cause), InvocationPriorAttempts) ?? [];

type InvocationAttemptFactory<E = never, R = never> = (
  attemptIndex: number,
) => Effect.Effect<InvocationAttempt, E, R>;

/**
 * Public entries take a raw retry count that never passed through `retryPolicySchema`. A NaN or
 * Infinity count would never end the retry loop, so entries parse it before any transport work.
 */
const retryBudgetSchema = stripStruct({
  retries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const withAttemptEvidence = (attempt: InvocationAttempt): InvocationAttempt => {
  if (attempt.rawExcerpt !== undefined) return attempt;
  const payload = attempt.status === 'ok' ? JSON.stringify(attempt.raw) : '';

  return { ...attempt, rawExcerpt: createRawExcerpt(payload) };
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

  if (error.applicationStarted === true) return false;

  if (error.code === 'cancelled') return false;

  if (error.code !== 'http_status') return true;

  return diagnostics.httpStatus !== undefined && diagnostics.httpStatus >= 500;
};

/** Runs transport attempts under the common validation, evidence, and retry rules. */
const invokeWithRetries = Effect.fn('invokeWithRetries')(function* <E, R>(
  invokeOnce: InvocationAttemptFactory<E, R>,
  retries: number,
): Effect.fn.Return<InvocationResult, E, R> {
  const attempts: InvocationAttempt[] = [];
  let attemptIndex = 0;

  for (;;) {
    const exit = yield* Effect.exit(invokeOnce(attemptIndex));

    if (Exit.isFailure(exit)) {
      return yield* Effect.failCause(
        Cause.annotate(
          exit.cause,
          Context.make(
            InvocationPriorAttempts,
            Object.freeze([...attempts, ...getInvocationPriorAttempts(exit.cause)]),
          ),
          { overwrite: true },
        ),
      );
    }

    const transportAttempt = withAttemptEvidence(exit.value);

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
});

export {
  getInvocationPriorAttempts,
  invokeWithRetries,
  retryBudgetSchema,
  type InvocationAttemptFactory,
};
