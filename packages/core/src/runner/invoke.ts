import {
  parseAgentResponse,
  type AgentRequest,
  type AgentTarget,
  type ContractIssue,
} from '@attest/contracts';

import { invokeCliAgent } from './cli-invoker.js';
import {
  AgentInvocationError,
  type AgentInvocationError as AgentInvocationErrorType,
} from './errors.js';
import { invokeHttpAgent } from './http-invoker.js';
import type {
  InvocationAttempt,
  InvocationDiagnostics,
  InvocationResult,
  InvokeOptions,
} from './types.js';

const invokeOnce = async (
  target: AgentTarget,
  request: AgentRequest,
  options: InvokeOptions,
): Promise<InvocationAttempt> => {
  if (target.type === 'cli') {
    return invokeCliAgent(target, request, options);
  }
  if (target.type === 'http') {
    return invokeHttpAgent(target, request, options);
  }

  const unreachableTarget: never = target;
  void unreachableTarget;
  throw new TypeError('Unsupported agent target');
};

const requireValidRetryCount = (retries: number): void => {
  if (Number.isInteger(retries) && retries >= 0) {
    return;
  }

  throw new TypeError('Retry count must be a non-negative integer');
};

/** Summarizes enough contract issues to identify a malformed envelope without obscuring retries. */
const summarizeContractIssues = (issues: ContractIssue[]): string => {
  const summary = issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return issues.length > 3 ? `${summary}; and ${String(issues.length - 3)} more` : summary;
};

/**
 * Validates a transport-successful raw response inside the retry boundary so invalid envelopes are
 * recorded and retried as invocation failures, while valid agent error envelopes remain case results.
 */
const validateResponseEnvelope = (
  attempt: Extract<InvocationAttempt, { status: 'ok' }>,
): InvocationAttempt => {
  const report = parseAgentResponse(attempt.raw);
  if (report.ok) {
    return { ...attempt, report };
  }

  return {
    status: 'invocation_error',
    error: new AgentInvocationError(
      'invalid_envelope',
      `Agent response envelope is invalid: ${summarizeContractIssues(report.errors)}`,
    ),
    diagnostics: attempt.diagnostics,
    durationMs: attempt.durationMs,
  };
};

/**
 * Determines retry eligibility under docs/specs/agent-contract.md: cancellation and HTTP 4xx are
 * terminal, while timeouts and all other invocation failures may consume the configured retry budget.
 */
const isRetryableInvocationError = (
  error: AgentInvocationErrorType,
  diagnostics: InvocationDiagnostics,
): boolean => {
  if (error.code === 'cancelled') {
    return false;
  }
  if (error.code !== 'http_status') {
    return true;
  }

  const status = diagnostics.httpStatus;
  return status === undefined || status < 400 || status >= 500;
};

/**
 * Dispatches an agent target and records every retry attempt for deterministic execution history,
 * following the invocation-error-only retry semantics in docs/specs/agent-contract.md.
 */
const invokeAgent = async (
  target: AgentTarget,
  request: AgentRequest,
  options: InvokeOptions & { retries: number },
): Promise<InvocationResult> => {
  requireValidRetryCount(options.retries);
  const attempts: InvocationAttempt[] = [];
  let attemptIndex = 0;
  while (true) {
    const transportAttempt = await invokeOnce(target, request, options);
    const attempt =
      transportAttempt.status === 'ok'
        ? validateResponseEnvelope(transportAttempt)
        : transportAttempt;
    attempts.push(attempt);
    if (attempt.status === 'ok') {
      return { ...attempt, attempts };
    }
    if (
      attemptIndex >= options.retries ||
      !isRetryableInvocationError(attempt.error, attempt.diagnostics)
    ) {
      return { ...attempt, attempts };
    }
    attemptIndex += 1;
  }
};

export { invokeAgent, isRetryableInvocationError };
