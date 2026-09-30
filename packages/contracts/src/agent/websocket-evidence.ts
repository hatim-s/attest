import { z } from 'zod';

import { webSocketConnectionModeSchema, webSocketLifecycleSchema } from './websocket-contract.js';
import { rawExcerptSchema, requestIdSchema } from '../project/shared.js';
import { WEBSOCKET_EVIDENCE_SCHEMA_ID } from '../schema/identifiers.js';

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

const webSocketEvidenceEventSchema = z.strictObject({
  classification: webSocketEvidenceClassificationSchema,
  elapsed_ms: z.number().int().nonnegative(),
  request_id: requestIdSchema.optional(),
  message_bytes: z.number().int().nonnegative().optional(),
  excerpt: rawExcerptSchema.optional(),
});

const webSocketCloseEvidenceSchema = z.strictObject({
  code: z.number().int().min(1_000).max(4_999).optional(),
  reason: z.string().max(123).optional(),
  clean: z.boolean(),
});

const webSocketEvidenceBaseFields = {
  schema: z.literal(WEBSOCKET_EVIDENCE_SCHEMA_ID),
  request_id: requestIdSchema,
  lifecycle: webSocketLifecycleSchema,
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
type WebSocketErrorClassification = z.infer<typeof webSocketErrorClassificationSchema>;

export {
  webSocketAttemptEvidenceSchema,
  webSocketErrorClassificationSchema,
  webSocketEvidenceClassificationSchema,
  type WebSocketAttemptEvidence,
  type WebSocketErrorClassification,
};
