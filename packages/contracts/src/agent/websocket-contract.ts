import { z } from 'zod';

import { agentRequestSchema } from './protocol.js';
import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  secretReferenceSchema,
  sha256Schema,
} from '../project/shared.js';
import {
  WEBSOCKET_EVIDENCE_SCHEMA_ID,
  WEBSOCKET_MESSAGE_PROTOCOL,
  WEBSOCKET_REQUEST_PROTOCOL,
} from '../schema/identifiers.js';

const webSocketRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    'must start with an alphanumeric character and contain only correlation-safe characters',
  );
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
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u, 'must be an HTTP header name');
const webSocketHeaderValueSchema = z.union([z.string(), secretReferenceSchema]);
const webSocketSubprotocolSchema = z
  .string()
  .min(1)
  .max(123)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u, 'must be one WebSocket subprotocol token')
  .refine(
    (protocol) =>
      !['graphql-ws', 'graphql-transport-ws', 'socket.io'].includes(protocol.toLowerCase()),
    'Socket.IO and GraphQL subscription subprotocols are unsupported',
  );

/** Counts exact correlation slots without interpreting any other authored template syntax. */
const countRequestIdSlots = (value: unknown): number => {
  if (value === '{{request_id}}') return 1;
  if (Array.isArray(value)) {
    let slots = 0;
    for (const item of value as unknown[]) slots += countRequestIdSlots(item);
    return slots;
  }
  if (value === null || typeof value !== 'object') return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (count, item) => count + countRequestIdSlots(item),
    0,
  );
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
 * Freezes the authored WebSocket transport surface consumed by the future adapter.
 * The enclosing agent retry budget may be used only while acknowledgement state is unacknowledged.
 */
const webSocketTransportSchema = z
  .strictObject({
    kind: z.literal('websocket'),
    lifecycle: z.enum(['per_case', 'per_run']),
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
  request_id: webSocketRequestIdSchema,
  request: agentRequestSchema,
});

/** Classifies a correlated text-JSON message after configured pointer extraction. */
const webSocketCorrelatedMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    protocol: z.literal(WEBSOCKET_MESSAGE_PROTOCOL),
    type: z.literal('acknowledgement'),
    request_id: webSocketRequestIdSchema,
    value: z.json(),
  }),
  z.strictObject({
    protocol: z.literal(WEBSOCKET_MESSAGE_PROTOCOL),
    type: z.literal('result'),
    request_id: webSocketRequestIdSchema,
    value: z.json(),
  }),
  z.strictObject({
    protocol: z.literal(WEBSOCKET_MESSAGE_PROTOCOL),
    type: z.literal('error'),
    request_id: webSocketRequestIdSchema,
    value: z.json(),
  }),
  z.strictObject({
    protocol: z.literal(WEBSOCKET_MESSAGE_PROTOCOL),
    type: z.literal('trace'),
    request_id: webSocketRequestIdSchema,
    value: z.json(),
  }),
]);

const webSocketEvidenceClassificationSchema = z.enum([
  'connection_opened',
  'request_sent',
  'acknowledgement_received',
  'trace_received',
  'result_received',
  'error_received',
  'ping_sent',
  'pong_received',
  'retry_scheduled',
  'reconnect_started',
  'connection_closed',
]);

const webSocketErrorClassificationSchema = z.enum([
  'open_timeout',
  'message_idle_timeout',
  'attempt_timeout',
  'close_timeout',
  'handshake_failed',
  'connection_failed',
  'unexpected_close',
  'invalid_json',
  'binary_frame_unsupported',
  'uncorrelated_server_work',
  'duplicate_terminal_message',
  'acknowledgement_extraction_failed',
  'result_extraction_failed',
  'error_extraction_failed',
  'trace_extraction_failed',
  'remote_error',
  'socket_io_unsupported',
  'graphql_subscription_unsupported',
  'interactive_auth_unsupported',
  'resume_unsupported',
  'bidirectional_callback_unsupported',
  'cancelled',
]);

const webSocketAcknowledgementEvidenceSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not_acknowledged'),
    retry: z.literal('allowed'),
    reconnect: z.literal('allowed'),
    replay: z.literal('allowed'),
  }),
  z.strictObject({
    state: z.literal('acknowledged'),
    retry: z.literal('forbidden'),
    reconnect: z.literal('forbidden'),
    replay: z.literal('forbidden'),
  }),
]);

const webSocketEvidenceExcerptSchema = z.discriminatedUnion('truncated', [
  z.strictObject({
    text: z.string().max(4_096),
    truncated: z.literal(false),
  }),
  z.strictObject({
    text: z.string().max(4_096),
    truncated: z.literal(true),
    sha256: sha256Schema,
  }),
]);

const webSocketEvidenceEventSchema = z.strictObject({
  classification: webSocketEvidenceClassificationSchema,
  elapsed_ms: z.number().int().nonnegative(),
  request_id: webSocketRequestIdSchema.optional(),
  message_bytes: z.number().int().nonnegative().optional(),
  excerpt: webSocketEvidenceExcerptSchema.optional(),
});

const webSocketCloseEvidenceSchema = z.strictObject({
  code: z.number().int().min(1_000).max(4_999).optional(),
  reason: z.string().max(123).optional(),
  clean: z.boolean(),
});

const webSocketEvidenceBaseFields = {
  schema: z.literal(WEBSOCKET_EVIDENCE_SCHEMA_ID),
  request_id: webSocketRequestIdSchema,
  lifecycle: z.enum(['per_case', 'per_run']),
  connection_mode: webSocketConnectionModeSchema,
  acknowledgement: webSocketAcknowledgementEvidenceSchema,
  events: z.array(webSocketEvidenceEventSchema).max(1_024),
  close: webSocketCloseEvidenceSchema.optional(),
};

/**
 * Persists bounded/redacted WebSocket decisions with a stable terminal classification.
 * Acknowledgement state makes the no-replay boundary machine-checkable on every attempt.
 */
const webSocketAttemptEvidenceSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...webSocketEvidenceBaseFields,
    outcome: z.literal('completed'),
  }),
  z.strictObject({
    ...webSocketEvidenceBaseFields,
    outcome: z.literal('failed'),
    error_classification: webSocketErrorClassificationSchema,
  }),
  z.strictObject({
    ...webSocketEvidenceBaseFields,
    outcome: z.literal('cancelled'),
    error_classification: z.literal('cancelled'),
  }),
]);

type WebSocketAttemptEvidence = z.infer<typeof webSocketAttemptEvidenceSchema>;
type WebSocketConnectionMode = z.infer<typeof webSocketConnectionModeSchema>;
type WebSocketCorrelatedMessage = z.infer<typeof webSocketCorrelatedMessageSchema>;
type WebSocketErrorClassification = z.infer<typeof webSocketErrorClassificationSchema>;
type WebSocketEvidenceClassification = z.infer<typeof webSocketEvidenceClassificationSchema>;
type WebSocketInvocationRequest = z.infer<typeof webSocketInvocationRequestSchema>;
type WebSocketTransport = z.infer<typeof webSocketTransportSchema>;

export {
  webSocketAttemptEvidenceSchema,
  webSocketConnectionModeSchema,
  webSocketCorrelatedMessageSchema,
  webSocketErrorClassificationSchema,
  webSocketEvidenceClassificationSchema,
  webSocketInvocationRequestSchema,
  webSocketRequestIdSchema,
  webSocketTransportSchema,
  type WebSocketAttemptEvidence,
  type WebSocketConnectionMode,
  type WebSocketCorrelatedMessage,
  type WebSocketErrorClassification,
  type WebSocketEvidenceClassification,
  type WebSocketInvocationRequest,
  type WebSocketTransport,
};
