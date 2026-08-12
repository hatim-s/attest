/**
 * Terminal classification of one executed case, shared by the runner (producer)
 * and the store (persistence) so the two can never drift (docs/TASTE.md: data first).
 */
type CaseOutcome = 'completed' | 'invocation_error' | 'timeout' | 'cancelled';

/**
 * Discriminates every way an agent invocation can fail before producing an
 * evaluable envelope (docs/specs/agent-contract.md, execution semantics).
 * Persisted verbatim by the store — values are lower_snake and append-only
 * within a contract version.
 */
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

export { type CaseOutcome, type InvocationErrorCode, type RawExcerpt };
