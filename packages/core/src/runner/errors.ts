import { AttestError } from '@attest/contracts';

/** Discriminates every way an agent invocation can fail before producing an evaluable envelope. */
type InvocationErrorCode =
  | 'spawn_failed'
  | 'timeout'
  | 'output_cap_exceeded'
  | 'nonzero_exit'
  | 'http_status'
  | 'network'
  | 'invalid_envelope'
  | 'cancelled';

/**
 * Raised when attest could not obtain a valid response envelope from an agent.
 *
 * Per docs/specs/agent-contract.md this is an infrastructure problem (invocation
 * error), distinct from an agent-reported `error` envelope which is a case result.
 * The code union is persisted verbatim by the store — extend it only in lockstep
 * with `StoredInvocationErrorCode` in the store package.
 */
class AgentInvocationError extends AttestError {
  declare readonly code: InvocationErrorCode;

  constructor(code: InvocationErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

export { AgentInvocationError, type InvocationErrorCode };
