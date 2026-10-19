import type {
  AGENT_PROTOCOL,
  AgentErrorResponse,
  InlineArtifact,
  JsonValue,
} from '@attest/contracts';

/** Extracted JSON fields awaiting the full native response and trace contract parser. */
type AgentResponseCandidate = {
  protocol: typeof AGENT_PROTOCOL;
  output?: JsonValue;
  error?: AgentErrorResponse['error'];
  state?: JsonValue;
  // parseAgentResponse validates the trace; a malformed one becomes a warning there.
  trace?: unknown;
  artifacts?: InlineArtifact[];
};

export type { AgentResponseCandidate };
