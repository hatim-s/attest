import type * as Cause from 'effect/Cause';
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
  /** Replay is unsafe after application evidence or uncertain dispatch/cleanup.
   * This conservative flag does not prove that remote application execution started. */
  applicationStarted?: boolean;
  /** WebSocket evidence classification recorded for this failure. */
  classification?: WebSocketErrorClassification;
};

/**
 * Effect evidence kept beside the failure for callers that inspect cleanup. These stay
 * non-enumerable, so spreading or serializing the error never copies them.
 */
type AgentInvocationErrorEvidence = {
  /** Process evidence from a managed agent that failed before it became ready. */
  diagnostics?: { exitCode?: number; stderrExcerpt?: string };
  /** The complete Cause this failure came from, including cleanup annotations. */
  effectCause?: Cause.Cause<unknown>;
  /** The failed sandbox stop that followed this failure. */
  sandboxCleanupCause?: Cause.Cause<unknown>;
  /** A sandbox artifact or setup failure recorded after this terminal attempt failed. */
  sandboxPostRunError?: AgentInvocationError;
};

type AgentInvocationErrorOptions = ErrorOptions &
  AgentInvocationErrorDetails &
  AgentInvocationErrorEvidence;

/** Keys of the evidence fields defined as non-enumerable own properties. */
const EVIDENCE_KEYS = [
  'diagnostics',
  'effectCause',
  'sandboxCleanupCause',
  'sandboxPostRunError',
] as const;

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
  declare readonly effectCause?: Cause.Cause<unknown>;
  declare readonly sandboxCleanupCause?: Cause.Cause<unknown>;
  declare readonly sandboxPostRunError?: AgentInvocationError;

  /** The options this error was built from, so a copy never depends on which fields enumerate. */
  readonly #options: AgentInvocationErrorOptions;

  constructor(
    code: InvocationErrorCode,
    message: string,
    options: AgentInvocationErrorOptions = {},
  ) {
    // Error reads only `cause`, and only when the key is present.
    super(code, message, options);
    this.#options = options;

    // Absent facts stay absent so logged errors show only what the transport observed.
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;

    if (options.rawExcerpt !== undefined) this.rawExcerpt = options.rawExcerpt;

    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;

    if (options.applicationStarted !== undefined) {
      this.applicationStarted = options.applicationStarted;
    }

    if (options.classification !== undefined) this.classification = options.classification;

    for (const key of EVIDENCE_KEYS) {
      if (options[key] === undefined) continue;
      void Object.defineProperty(this, key, { configurable: true, value: options[key] });
    }
  }

  /**
   * Returns a copy of the same class with `options` laid over the options this error was built
   * from. Fields are fixed at construction, so callers that learn more later replace the error
   * instead of mutating an instance another fiber may hold.
   */
  copyWith(options: AgentInvocationErrorOptions): AgentInvocationError {
    return this.rebuild({ ...this.#options, ...options });
  }

  /**
   * Builds this error again from merged options. A subclass with its own constructor state
   * overrides this so a copy keeps its class and fields.
   */
  protected rebuild(options: AgentInvocationErrorOptions): AgentInvocationError {
    return new AgentInvocationError(this.code, this.message, options);
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
