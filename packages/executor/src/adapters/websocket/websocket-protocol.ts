import { isDeepStrictEqual } from 'node:util';

import type {
  AgentRequest,
  AgentResource,
  JsonValue,
  SecretReference,
  WebSocketErrorClassification,
} from '@attest/contracts';
import { WEBSOCKET_REQUEST_PROTOCOL } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { DEFAULT_REQUEST_BYTES } from '../../internal/agent-defaults.js';
import { isJsonValue } from '../../internal/json-value.js';
import { extractRemoteError } from '../../internal/remote-error.js';
import { readJsonPointer } from '../http/json-pointer.js';

type WebSocketAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'websocket' }>;
};

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

type ServerEnvelope = {
  raw: unknown;
  requestId: string;
};

type EnvelopeFailure = {
  classification: WebSocketErrorClassification;
  error: AgentInvocationError;
};

type MessageTerminal =
  | { kind: 'error'; value: { code?: string; message: string } }
  | { kind: 'result'; value: JsonValue };

type MessageInterpretation = {
  acknowledgement: boolean;
  failure?: EnvelopeFailure;
  terminal?: MessageTerminal;
  trace?: JsonValue;
};

const isSecretReference = (value: string | SecretReference): value is SecretReference =>
  typeof value !== 'string';

/** Maps transport failures onto the stable WebSocket evidence vocabulary. */
const errorClassification = (error: AgentInvocationError): WebSocketErrorClassification => {
  if (error.classification !== undefined) return error.classification;
  if (error.code === 'cancelled') return 'cancelled';
  if (error.code === 'timeout') return 'attempt_timeout';
  if (error.code === 'invalid_envelope') return 'invalid_json';
  return 'connection_failed';
};

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
    if (normalized === 'authorization' && !isSecretReference(value)) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Literal WebSocket authorization is unsupported.',
      );
    }
    const resolved = resolvedByName.get(normalized);
    if (isSecretReference(value) && resolved === undefined) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `WebSocket secret header ${name} was not resolved at runtime.`,
      );
    }
    materialized.set(normalized, [name, resolved?.[1] ?? (value as string)]);
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
  const rendered = replace(agent.transport.request_template);
  const text = JSON.stringify({
    ...(rendered as Record<string, JsonValue>),
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

/** Parses JSON and extracts the request id before session correlation. */
const parseServerEnvelope = (
  text: string,
  requestIdPointer: string,
): ServerEnvelope | EnvelopeFailure => {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause: unknown) {
    return {
      classification: 'invalid_json',
      error: new AgentInvocationError('invalid_envelope', 'WebSocket message is not valid JSON.', {
        cause,
      }),
    };
  }
  const requestId = readJsonPointer(raw, requestIdPointer);
  if (typeof requestId !== 'string') {
    return {
      classification: 'uncorrelated_server_work',
      error: new AgentInvocationError(
        'invalid_envelope',
        'WebSocket server work is missing a bounded correlation id.',
      ),
    };
  }
  return { raw, requestId };
};

/** Interprets one correlated envelope as progress, a terminal value, or a protocol failure. */
const interpretServerMessage = (
  raw: unknown,
  agent: WebSocketAgentResource,
  previouslyAcknowledged: boolean,
): MessageInterpretation => {
  const acknowledgementValue = readJsonPointer(raw, agent.transport.acknowledgement_pointer);
  const result = readJsonPointer(raw, agent.transport.result_pointer);
  const extractedError = readJsonPointer(raw, agent.transport.error_pointer);
  const rawTrace =
    agent.transport.trace_pointer === undefined
      ? undefined
      : readJsonPointer(raw, agent.transport.trace_pointer);
  const acknowledgement = agent.transport.acknowledgement_values.some((value) =>
    isDeepStrictEqual(value, acknowledgementValue),
  );

  if (rawTrace !== undefined && !isJsonValue(rawTrace)) {
    return {
      acknowledgement,
      failure: {
        classification: 'trace_extraction_failed',
        error: new AgentInvocationError('invalid_envelope', 'WebSocket trace extraction failed.'),
      },
    };
  }

  const progress = {
    acknowledgement,
    ...(rawTrace === undefined ? {} : { trace: rawTrace }),
  };
  const invalid = (
    classification: WebSocketErrorClassification,
    message: string,
  ): MessageInterpretation => ({
    ...progress,
    failure: {
      classification,
      error: new AgentInvocationError('invalid_envelope', message),
    },
  });
  const hasResult = result !== undefined;
  const hasError = extractedError !== undefined && extractedError !== null;
  if (hasResult && hasError) {
    return invalid(
      'result_extraction_failed',
      'WebSocket message contains both result and error values.',
    );
  }

  if ((hasResult || hasError) && !previouslyAcknowledged && !acknowledgement) {
    return invalid(
      'acknowledgement_extraction_failed',
      'WebSocket terminal message arrived before acknowledgement.',
    );
  }

  if (hasError) {
    return {
      ...progress,
      terminal: {
        kind: 'error',
        value: extractRemoteError(extractedError, 'The WebSocket agent reported an error.'),
      },
    };
  }
  if (hasResult) {
    if (!isJsonValue(result)) {
      return invalid('result_extraction_failed', 'WebSocket result extraction failed.');
    }
    return {
      ...progress,
      terminal: { kind: 'result', value: result },
    };
  }
  if (!acknowledgement && rawTrace === undefined) {
    return invalid(
      'acknowledgement_extraction_failed',
      'WebSocket acknowledgement extraction failed.',
    );
  }
  return progress;
};

export {
  errorClassification,
  interpretServerMessage,
  materializeHeaders,
  materializeRequest,
  parseServerEnvelope,
  type WebSocketAgentResource,
};
