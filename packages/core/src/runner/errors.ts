import { AttestError, type InvocationErrorCode } from '@attest/contracts';

/**
 * Raised when attest could not obtain a valid response envelope from an agent.
 *
 * Per docs/specs/agent-contract.md this is an infrastructure problem (invocation
 * error), distinct from an agent-reported `error` envelope which is a case result.
 * The code union lives in @attest/contracts because the store persists it verbatim.
 */
class AgentInvocationError extends AttestError {
  declare readonly code: InvocationErrorCode;

  constructor(code: InvocationErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

export { AgentInvocationError, type InvocationErrorCode };
