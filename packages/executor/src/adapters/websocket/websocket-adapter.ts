import { webSocketTransportSchema, type AgentRequest } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import type { InvocationResult } from '../../types.js';
import { PerCaseWebSocketSession } from './per-case-session.js';
import { RunScopedWebSocketSession } from './run-scoped-session.js';
import type { WebSocketAgentResource } from './websocket-protocol.js';
import type { WebSocketSessionOptions } from './websocket-session-state.js';

/** One WebSocket agent lifecycle; `close` ends it and releases every connection. */
type WebSocketAgentSession = {
  invoke: (request: AgentRequest, signal?: AbortSignal) => Promise<InvocationResult>;
  close: () => Promise<void>;
};

/**
 * Validates the frozen transport before any connection opens, then starts a session that either
 * shares one connection across the run or opens one per case. Invalid transports throw
 * synchronously so a misconfigured run fails before it schedules cases.
 */
const startWebSocketAgent = (
  agent: WebSocketAgentResource,
  options: WebSocketSessionOptions = {},
): Promise<WebSocketAgentSession> => {
  if (!webSocketTransportSchema.safeParse(agent.transport).success) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'WebSocket transport uses an invalid or unsupported mode.',
    );
  }
  if (agent.transport.url.includes('{{')) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'WebSocket runtime URLs must have a static authority and path.',
    );
  }
  const session =
    agent.transport.lifecycle === 'per_case'
      ? new PerCaseWebSocketSession(agent, options)
      : new RunScopedWebSocketSession(agent, options);
  return Promise.resolve(session);
};

export {
  startWebSocketAgent,
  type WebSocketAgentResource,
  type WebSocketAgentSession,
  type WebSocketSessionOptions,
};
