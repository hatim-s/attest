import { WEBSOCKET_REQUEST_PROTOCOL, type AgentRequest, type JsonValue } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { DEFAULT_REQUEST_BYTES } from '../../internal/agent-defaults.js';
import type { WebSocketAgentResource } from './websocket-protocol.js';

/** Headers the handshake itself controls, which authored configuration must never override. */
const FORBIDDEN_HANDSHAKE_HEADERS = new Set([
  'connection',
  'cookie',
  'host',
  'proxy-authorization',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'upgrade',
]);

/** Materializes environment-backed headers and rejects reserved handshake fields. */
const materializeHeaders = (
  agent: WebSocketAgentResource,
  resolvedHeaders: Record<string, string>,
): Record<string, string> => {
  const authored = agent.transport.headers ?? {};
  const resolvedByName = new Map(
    Object.entries(resolvedHeaders).map(([name, value]) => [
      name.toLowerCase(),
      [name, value] as const,
    ]),
  );
  const materialized = new Map<string, [string, string]>();

  for (const [name, value] of Object.entries(authored)) {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_HANDSHAKE_HEADERS.has(normalized)) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `WebSocket header ${name} is controlled by the runtime or unsupported.`,
      );
    }
    const resolved = resolvedByName.get(normalized)?.[1];
    if (typeof value === 'string') {
      if (normalized === 'authorization') {
        throw new AgentInvocationError(
          'invalid_envelope',
          'Literal WebSocket authorization is unsupported.',
        );
      }
      materialized.set(normalized, [name, resolved ?? value]);
      continue;
    }
    if (resolved === undefined) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `WebSocket secret header ${name} was not resolved at runtime.`,
      );
    }
    materialized.set(normalized, [name, resolved]);
  }

  for (const [normalized, [name, value]] of resolvedByName) {
    if (FORBIDDEN_HANDSHAKE_HEADERS.has(normalized)) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `WebSocket header ${name} is controlled by the runtime or unsupported.`,
      );
    }
    materialized.set(normalized, [name, value]);
  }
  return Object.fromEntries(materialized.values());
};

/** Renders the correlation slot and attaches the normalized invocation request. */
const materializeRequest = (
  agent: WebSocketAgentResource,
  request: AgentRequest,
  requestId: string,
): string => {
  const replace = (value: JsonValue): JsonValue => {
    if (value === '{{request_id}}') return requestId;
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  const rendered = Object.fromEntries(
    Object.entries(agent.transport.request_template).map(([key, value]) => [key, replace(value)]),
  );
  const text = JSON.stringify({
    ...rendered,
    protocol: WEBSOCKET_REQUEST_PROTOCOL,
    request_id: requestId,
    request,
  });
  const cap = agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES;
  if (Buffer.byteLength(text) > cap) {
    throw new AgentInvocationError(
      'output_cap_exceeded',
      `WebSocket request exceeds the ${cap}-byte request cap.`,
    );
  }
  return text;
};

export { materializeHeaders, materializeRequest };
