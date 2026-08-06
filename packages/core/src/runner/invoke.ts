import {
  parseAgentResponse,
  type AgentRequest,
  type AgentTarget,
  type ContractIssue,
} from '@attest/contracts';

import { invokeCliAgent } from './cli-invoker.js';
import { AgentInvocationError } from './errors.js';
import { invokeHttpAgent } from './http-invoker.js';
import { createRawExcerpt } from './internal/raw-excerpt.js';
import type {
  InvocationAttempt,
  InvocationDiagnostics,
  InvocationResult,
  InvokeAgentOptions,
} from './types.js';

type RunnerInvokeAgentOptions = Omit<InvokeAgentOptions, 'env'> & {
  env?: Record<string, string>;
  envAllowlist?: readonly string[];
};

const withAttemptEvidence = (attempt: InvocationAttempt): InvocationAttempt => {
  if (attempt.rawExcerpt !== undefined) {
    return attempt;
  }

  const payload = attempt.status === 'ok' ? JSON.stringify(attempt.raw) : '';
  return { ...attempt, rawExcerpt: createRawExcerpt(payload), warnings: attempt.warnings ?? [] };
};

const invokeOnce = async (
  target: AgentTarget,
  request: AgentRequest,
  options: RunnerInvokeAgentOptions,
): Promise<InvocationAttempt> => {
  if (target.type === 'cli') {
    return invokeCliAgent(target, request, options);
  }
  if (target.type === 'http') {
    return invokeHttpAgent(target, request, { ...options, env: options.env ?? {} });
  }

  target satisfies never;
  throw new TypeError('Unsupported agent target');
};

const requireValidRetryCount = (retries: number): void => {
  if (Number.isInteger(retries) && retries >= 0) {
    return;
  }

  throw new TypeError('Retry count must be a non-negative integer');
};

/** Summarizes contract issues without obscuring the retry classification. */
const summarizeContractIssues = (issues: ContractIssue[]): string => {
  const summary = issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return issues.length > 3 ? `${summary}; and ${String(issues.length - 3)} more` : summary;
};

/**
 * Validates transport output inside the retry boundary per docs/specs/agent-contract.md, retaining
 * bounded evidence and parse warnings even when schema failure converts success into an invocation error.
 */
const validateResponseEnvelope = (
  attempt: Extract<InvocationAttempt, { status: 'ok' }>,
): InvocationAttempt => {
  const report = parseAgentResponse(attempt.raw);
  if (report.ok) {
    return { ...attempt, report, warnings: report.warnings };
  }

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

/** Implements the invocation-error-only retry policy from docs/specs/agent-contract.md. */
const isRetryableInvocationError = (
  error: AgentInvocationError,
  diagnostics: InvocationDiagnostics,
): boolean => {
  if (error.code === 'cancelled') {
    return false;
  }
  if (error.code !== 'http_status') {
    return true;
  }

  return diagnostics.httpStatus !== undefined && diagnostics.httpStatus >= 500;
};

/** Dispatches one target and retains every validated retry attempt for deterministic recording. */
const invokeAgent = async (
  target: AgentTarget,
  request: AgentRequest,
  options: RunnerInvokeAgentOptions,
): Promise<InvocationResult> => {
  requireValidRetryCount(options.retries);
  const attempts: InvocationAttempt[] = [];
  let attemptIndex = 0;
  while (true) {
    const transportAttempt = withAttemptEvidence(await invokeOnce(target, request, options));
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
