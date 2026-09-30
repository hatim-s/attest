import { z } from 'zod';

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

const webSocketLifecycleSchema = z.enum(['per_case', 'per_run']);
const webSocketConnectionModeSchema = z.enum(['serial', 'multiplexed']);
const webSocketJsonPointerSchema = jsonPointerSchema.refine(
  (pointer) => pointer !== '',
  'must address a field rather than the whole message',
);
const webSocketUrlTemplateSchema = z
  .string()
  .regex(/^wss?:\/\/\S+$/u, 'must be a WebSocket URL template')
  .refine(
    (url) => !/(?:^|\/)socket\.io(?:\/|\?|$)|[?&]EIO=/iu.test(url),
    'Socket.IO endpoints are unsupported; configure a plain WebSocket endpoint',
  );
const webSocketHeaderNameSchema = z
  .string()
  .min(1)
  .regex(httpTokenPattern, 'must be an HTTP header name');
const webSocketHeaderValueSchema = z.union([z.string(), secretReferenceSchema]);
const webSocketSubprotocolSchema = z
  .string()
  .min(1)
  .max(123)
  .regex(httpTokenPattern, 'must be one WebSocket subprotocol token')
  .refine(
    (protocol) =>
      !['graphql-ws', 'graphql-transport-ws', 'socket.io'].includes(protocol.toLowerCase()),
    'Socket.IO and GraphQL subscription subprotocols are unsupported',
  );

/** Counts exact correlation slots without interpreting any other authored template syntax. */
const countRequestIdSlots = (value: unknown): number => {
  if (value === '{{request_id}}') {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((count, item) => count + countRequestIdSlots(item), 0);
  }
  if (value === null || typeof value !== 'object') {
    return 0;
  }

  return Object.values(value).reduce<number>((count, item) => count + countRequestIdSlots(item), 0);
};

const webSocketRequestTemplateSchema = z
  .record(z.string(), z.json())
  .superRefine((template, context) => {
    if (countRequestIdSlots(template) !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'must contain exactly one {{request_id}} correlation slot',
      });
    }
  });

/**
 * Authored WebSocket transport. Retries are allowed only before the server acknowledges the
 * request.
 */
const webSocketTransportSchema = z
  .strictObject({
    kind: z.literal('websocket'),
    lifecycle: webSocketLifecycleSchema,
    connection_mode: webSocketConnectionModeSchema,
    framing: z.literal('text_json'),
    url: webSocketUrlTemplateSchema,
    headers: z.record(webSocketHeaderNameSchema, webSocketHeaderValueSchema).optional(),
    subprotocol: webSocketSubprotocolSchema.optional(),
    request_template: webSocketRequestTemplateSchema,
    request_id_pointer: webSocketJsonPointerSchema,
    acknowledgement_pointer: webSocketJsonPointerSchema,
    acknowledgement_values: z.array(z.json()).nonempty(),
    result_pointer: webSocketJsonPointerSchema,
    error_pointer: webSocketJsonPointerSchema,
    trace_pointer: webSocketJsonPointerSchema.optional(),
    open_timeout_ms: durationMillisecondsSchema,
    message_idle_timeout_ms: durationMillisecondsSchema,
    attempt_timeout_ms: durationMillisecondsSchema,
    ping_interval_ms: durationMillisecondsSchema,
    close_timeout_ms: durationMillisecondsSchema,
    retry_boundary: z.literal('before_acknowledgement'),
    replay_after_acknowledgement: z.literal(false),
  })
  .superRefine((transport, context) => {
    if (transport.lifecycle === 'per_case' && transport.connection_mode !== 'serial') {
      context.addIssue({
        code: 'custom',
        path: ['connection_mode'],
        message: 'per_case connections are serial; multiplexing requires lifecycle per_run',
      });
    }

    if (transport.open_timeout_ms > transport.attempt_timeout_ms) {
      context.addIssue({
        code: 'custom',
        path: ['open_timeout_ms'],
        message: 'must not exceed attempt_timeout_ms',
      });
    }
    if (transport.message_idle_timeout_ms > transport.attempt_timeout_ms) {
      context.addIssue({
        code: 'custom',
        path: ['message_idle_timeout_ms'],
        message: 'must not exceed attempt_timeout_ms',
      });
    }
    if (transport.ping_interval_ms >= transport.message_idle_timeout_ms) {
      context.addIssue({
        code: 'custom',
        path: ['ping_interval_ms'],
        message: 'must be less than message_idle_timeout_ms',
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
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `must not reuse ${firstPath}`,
        });
      } else {
        firstPathByPointer.set(pointer, path);
      }
    }

    for (const [name, value] of Object.entries(transport.headers ?? {})) {
      const normalizedName = name.toLowerCase();
      if (normalizedName === 'cookie') {
        context.addIssue({
          code: 'custom',
          path: ['headers', name],
          message: 'cookies are unsupported',
        });
      }
      if (
        (normalizedName === 'authorization' || normalizedName === 'proxy-authorization') &&
        typeof value === 'string'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['headers', name],
          message: 'literal authorization is unsupported; use a secret reference',
        });
      }
    }
  })
  .meta({ id: 'WebSocketTransport' });

/** Normalizes one adapter invocation before the authored request template is rendered. */
const webSocketInvocationRequestSchema = z.strictObject({
  protocol: z.literal(WEBSOCKET_REQUEST_PROTOCOL),
  request_id: requestIdSchema,
  request: agentRequestSchema,
});

/** Classifies a correlated text-JSON message after configured pointer extraction. */
const webSocketCorrelatedMessageSchema = z.strictObject({
  protocol: z.literal(WEBSOCKET_MESSAGE_PROTOCOL),
  type: z.enum(['acknowledgement', 'result', 'error', 'trace']),
  request_id: requestIdSchema,
  value: z.json(),
});

type WebSocketCorrelatedMessage = z.infer<typeof webSocketCorrelatedMessageSchema>;
type WebSocketInvocationRequest = z.infer<typeof webSocketInvocationRequestSchema>;
type WebSocketTransport = z.infer<typeof webSocketTransportSchema>;

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
