import { z } from 'zod';

/**
 * Terminal classification of one executed case. The runner produces it and the store persists
 * it, so both read the same enum.
 */
const caseOutcomeSchema = z.enum(['completed', 'invocation_error', 'timeout', 'cancelled']);

/**
 * Every way an agent invocation can fail before producing an evaluable envelope
 * (docs/specs/agent-contract.md, execution semantics). The store persists these values verbatim,
 * so they are append-only within a contract version.
 */
const invocationErrorCodeSchema = z.enum([
  'spawn_failed',
  'timeout',
  'output_cap_exceeded',
  'nonzero_exit',
  'http_status',
  'network',
  'invalid_envelope',
  'cancelled',
]);

/** Recoverable problems reported alongside a successfully parsed agent response. */
const warningCodeSchema = z.enum(['unknown_field', 'invalid_trace']);

/**
 * Bounded evidence of a transport payload, retained per attempt so runs stay
 * auditable without persisting unbounded bodies. On cap overflow the excerpt
 * keeps a prefix plus the digest of everything received.
 */
type RawExcerpt = {
  text: string;
  truncated: boolean;
  /** SHA-256 of the full received payload; present only when truncated. */
  sha256?: string;
};

type CaseOutcome = z.infer<typeof caseOutcomeSchema>;
type InvocationErrorCode = z.infer<typeof invocationErrorCodeSchema>;
type WarningCode = z.infer<typeof warningCodeSchema>;

export {
  caseOutcomeSchema,
  invocationErrorCodeSchema,
  warningCodeSchema,
  type CaseOutcome,
  type InvocationErrorCode,
  type RawExcerpt,
  type WarningCode,
};
