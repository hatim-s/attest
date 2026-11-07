import { isString, type JsonValue } from '../project/shared.js';
import * as Schema from 'effect/Schema';

import { agentRequestSchema } from './protocol.js';
import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  requestIdSchema,
  secretReferenceSchema,
} from '../project/shared.js';
import { WEBSOCKET_MESSAGE_PROTOCOL, WEBSOCKET_REQUEST_PROTOCOL } from '../schema/identifiers.js';

// RFC 9110 token characters, shared by header names and subprotocol names.
const httpTokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

const webSocketLifecycleSchema = Schema.Literals(['per_case', 'per_run']);

const webSocketConnectionModeSchema = Schema.Literals(['serial', 'multiplexed']);

const webSocketJsonPointerSchema = jsonPointerSchema.check(
  Schema.makeFilter((pointer) =>
    pointer !== '' ? undefined : 'must address a field rather than the whole message',
  ),
);

const webSocketUrlTemplateSchema = Schema.String.check(
  Schema.isPattern(/^wss?:\/\/\S+$/u, { message: 'must be a WebSocket URL template' }),
).check(
  Schema.makeFilter((url) =>
    !/(?:^|\/)socket\.io(?:\/|\?|$)|[?&]EIO=/iu.test(url)
      ? undefined
      : 'Socket.IO endpoints are unsupported; configure a plain WebSocket endpoint',
  ),
);

const webSocketHeaderNameSchema = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.isPattern(httpTokenPattern, { message: 'must be an HTTP header name' }),
);

const webSocketHeaderValueSchema = Schema.Union([Schema.String, secretReferenceSchema]);

const webSocketSubprotocolSchema = Schema.String.check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(123))
  .check(Schema.isPattern(httpTokenPattern, { message: 'must be one WebSocket subprotocol token' }))
  .check(
    Schema.makeFilter((protocol) =>
      !['graphql-ws', 'graphql-transport-ws', 'socket.io'].includes(protocol.toLowerCase())
        ? undefined
        : 'Socket.IO and GraphQL subscription subprotocols are unsupported',
    ),
  );

const isJsonContainer = (
  value: JsonValue,
): value is Record<string, JsonValue> | readonly JsonValue[] =>
  value !== null && typeof value === 'object';

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

/** Counts exact correlation slots without interpreting any other authored template syntax. */
const countRequestIdSlots = (value: JsonValue): number => {
  if (value === '{{request_id}}') {
    return 1;
  }

  if (isJsonArray(value)) {
    return value.reduce<number>((count, item) => count + countRequestIdSlots(item), 0);
  }

  if (!isJsonContainer(value)) {
    return 0;
  }

  return Object.values(value).reduce<number>((count, item) => count + countRequestIdSlots(item), 0);
};

const webSocketRequestTemplateSchema = Schema.Record(Schema.String, Schema.Json).check(
  Schema.makeFilter((template) => {
    const context: Schema.FilterIssue[] = [];

    if (countRequestIdSlots(template) !== 1) {
      context.push({
        path: [],
        issue: 'must contain exactly one {{request_id}} correlation slot',
      });
    }

    return context;
  }),
);

/**
 * Authored WebSocket transport. Retries are allowed only before the server acknowledges the
 * request.
 */
const webSocketTransportSchema = Schema.Struct({
  kind: Schema.Literal('websocket'),
  lifecycle: webSocketLifecycleSchema,
  connection_mode: webSocketConnectionModeSchema,
  framing: Schema.Literal('text_json'),
  url: webSocketUrlTemplateSchema,
  headers: Schema.optional(Schema.Record(webSocketHeaderNameSchema, webSocketHeaderValueSchema)),
  subprotocol: Schema.optional(webSocketSubprotocolSchema),
  request_template: webSocketRequestTemplateSchema,
  request_id_pointer: webSocketJsonPointerSchema,
  acknowledgement_pointer: webSocketJsonPointerSchema,
  acknowledgement_values: Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  result_pointer: webSocketJsonPointerSchema,
  error_pointer: webSocketJsonPointerSchema,
  trace_pointer: Schema.optional(webSocketJsonPointerSchema),
  open_timeout_ms: durationMillisecondsSchema,
  message_idle_timeout_ms: durationMillisecondsSchema,
  attempt_timeout_ms: durationMillisecondsSchema,
  ping_interval_ms: durationMillisecondsSchema,
  close_timeout_ms: durationMillisecondsSchema,
  retry_boundary: Schema.Literal('before_acknowledgement'),
  replay_after_acknowledgement: Schema.Literal(false),
})
  .check(
    Schema.makeFilter((transport) => {
      const context: Schema.FilterIssue[] = [];

      if (transport.lifecycle === 'per_case' && transport.connection_mode !== 'serial') {
        context.push({
          path: ['connection_mode'],
          issue: 'per_case connections are serial; multiplexing requires lifecycle per_run',
        });
      }

      if (transport.open_timeout_ms > transport.attempt_timeout_ms) {
        context.push({
          path: ['open_timeout_ms'],
          issue: 'must not exceed attempt_timeout_ms',
        });
      }

      if (transport.message_idle_timeout_ms > transport.attempt_timeout_ms) {
        context.push({
          path: ['message_idle_timeout_ms'],
          issue: 'must not exceed attempt_timeout_ms',
        });
      }

      if (transport.ping_interval_ms >= transport.message_idle_timeout_ms) {
        context.push({
          path: ['ping_interval_ms'],
          issue: 'must be less than message_idle_timeout_ms',
        });
      }

      const pointers = [
        ['request_id_pointer', transport.request_id_pointer],
        ['acknowledgement_pointer', transport.acknowledgement_pointer],
        ['result_pointer', transport.result_pointer],
        ['error_pointer', transport.error_pointer],
        ...(transport.trace_pointer === undefined
          ? []
          : ([['trace_pointer', transport.trace_pointer]] as const)),
      ] as const;

      const firstPathByPointer = new Map<string, string>();

      for (const [path, pointer] of pointers) {
        const firstPath = firstPathByPointer.get(pointer);

        if (firstPath !== undefined) {
          context.push({
            path: [path],
            issue: `must not reuse ${firstPath}`,
          });
        } else {
          firstPathByPointer.set(pointer, path);
        }
      }

      for (const [name, value] of Object.entries(transport.headers ?? {})) {
        const normalizedName = name.toLowerCase();

        if (normalizedName === 'cookie') {
          context.push({
            path: ['headers', name],
            issue: 'cookies are unsupported',
          });
        }

        if (
          (normalizedName === 'authorization' || normalizedName === 'proxy-authorization') &&
          isString(value)
        ) {
          context.push({
            path: ['headers', name],
            issue: 'literal authorization is unsupported; use a secret reference',
          });
        }
      }

      return context;
    }),
  )
  .annotate({ identifier: 'WebSocketTransport' });

/** Normalizes one adapter invocation before the authored request template is rendered. */
const webSocketInvocationRequestSchema = Schema.Struct({
  protocol: Schema.Literal(WEBSOCKET_REQUEST_PROTOCOL),
  request_id: requestIdSchema,
  request: agentRequestSchema,
});

/** Classifies a correlated text-JSON message after configured pointer extraction. */
const webSocketCorrelatedMessageSchema = Schema.Struct({
  protocol: Schema.Literal(WEBSOCKET_MESSAGE_PROTOCOL),
  type: Schema.Literals(['acknowledgement', 'result', 'error', 'trace']),
  request_id: requestIdSchema,
  value: Schema.Json,
});

type WebSocketCorrelatedMessage = typeof webSocketCorrelatedMessageSchema.Type;

type WebSocketInvocationRequest = typeof webSocketInvocationRequestSchema.Type;

type WebSocketTransport = typeof webSocketTransportSchema.Type;

export {
  webSocketConnectionModeSchema,
  webSocketCorrelatedMessageSchema,
  webSocketInvocationRequestSchema,
  webSocketLifecycleSchema,
  webSocketTransportSchema,
  type WebSocketCorrelatedMessage,
  type WebSocketInvocationRequest,
  type WebSocketTransport,
};
