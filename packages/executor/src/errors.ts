import {
  AttestError,
  type InvocationErrorCode,
  type RawExcerpt,
  type WebSocketErrorClassification,
} from '@attest/contracts';

/** Transport facts a failure carries from the transport up to the attempt that records it. */
type AgentInvocationErrorDetails = {
  /** Status of the HTTP response that caused the failure. */
  httpStatus?: number;
  /** Bounded payload evidence captured before the failure. */
  rawExcerpt?: RawExcerpt;
  /** Duration of the single request that failed when an invocation spans several requests. */
  attemptDurationMs?: number;
  /** Server-requested delay parsed from Retry-After. */
  retryAfterMs?: number;
  /** A stream delivered an application event, so replaying the request could duplicate work. */
  applicationStarted?: boolean;
  /** WebSocket evidence classification recorded for this failure. */
  classification?: WebSocketErrorClassification;
  /** Process evidence from a managed agent that failed before it became ready. */
  diagnostics?: { exitCode?: number; stderrExcerpt?: string };
};

type AgentInvocationErrorOptions = ErrorOptions & AgentInvocationErrorDetails;

/**
 * Raised when attest could not obtain a valid response envelope from an agent.
 *
 * Per docs/specs/agent-contract.md this is an infrastructure problem (invocation
 * error), distinct from an agent-reported `error` envelope which is a case result.
 * The code union lives in @attest/contracts because the store persists it verbatim.
 */
class AgentInvocationError extends AttestError {
  declare readonly code: InvocationErrorCode;
  declare httpStatus?: number;
  declare rawExcerpt?: RawExcerpt;
  declare attemptDurationMs?: number;
  declare retryAfterMs?: number;
  declare applicationStarted?: boolean;
  declare classification?: WebSocketErrorClassification;
  declare diagnostics?: { exitCode?: number; stderrExcerpt?: string };

  constructor(
    code: InvocationErrorCode,
    message: string,
    options: AgentInvocationErrorOptions = {},
  ) {
    const { cause, ...details } = options;
    super(code, message, 'cause' in options ? { cause } : undefined);
    Object.assign(this, details);
  }
}

/**
 * Classifies an aborted operation. Only an abort of the caller's own signal is a cancellation;
 * every other abort comes from a deadline the transport owns, so it is a timeout.
 */
const abortedError = (
  callerSignal: AbortSignal | undefined,
  operation: string,
  options?: AgentInvocationErrorOptions,
): AgentInvocationError => {
  if (callerSignal?.aborted === true) {
    return new AgentInvocationError('cancelled', `${operation} was cancelled.`, options);
  }
  return new AgentInvocationError('timeout', `${operation} timed out.`, options);
};

export {
  AgentInvocationError,
  abortedError,
  type AgentInvocationErrorOptions,
  type InvocationErrorCode,
};
