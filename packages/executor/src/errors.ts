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
  declare readonly httpStatus?: number;
  declare readonly rawExcerpt?: RawExcerpt;
  declare readonly retryAfterMs?: number;
  declare readonly applicationStarted?: boolean;
  declare readonly classification?: WebSocketErrorClassification;
  declare readonly diagnostics?: { exitCode?: number; stderrExcerpt?: string };

  constructor(
    code: InvocationErrorCode,
    message: string,
    options: AgentInvocationErrorOptions = {},
  ) {
    // Error reads only `cause`, and only when the key is present.
    super(code, message, options);

    // Absent facts stay absent so logged errors show only what the transport observed.
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;

    if (options.rawExcerpt !== undefined) this.rawExcerpt = options.rawExcerpt;

    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;

    if (options.applicationStarted !== undefined) {
      this.applicationStarted = options.applicationStarted;
    }

    if (options.classification !== undefined) this.classification = options.classification;

    if (options.diagnostics !== undefined) this.diagnostics = options.diagnostics;
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
