import type { AGENT_PROTOCOL, AgentErrorResponse, JsonValue } from '@attest/contracts';

/** Extracted JSON fields awaiting the full native response and trace contract parser. */
type AgentResponseCandidate = {
  protocol: typeof AGENT_PROTOCOL;
  output?: JsonValue;
  error?: AgentErrorResponse['error'];
  trace?: JsonValue;
};

export type { AgentResponseCandidate };
