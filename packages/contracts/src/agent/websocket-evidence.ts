import { safeIntegerSchema, nonnegativeIntegerSchema } from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { webSocketConnectionModeSchema, webSocketLifecycleSchema } from './websocket-contract.js';
import { rawExcerptSchema, requestIdSchema } from '../project/shared.js';
import { WEBSOCKET_EVIDENCE_SCHEMA_ID } from '../schema/identifiers.js';

const webSocketEvidenceClassificationSchema = Schema.Literals([
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

const webSocketErrorClassificationSchema = Schema.Literals([
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
  'trace_extraction_failed',
  'remote_error',
  'cancelled',
]);

const webSocketAcknowledgementEvidenceSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal('not_acknowledged'),
    retry: Schema.Literal('allowed'),
    reconnect: Schema.Literal('allowed'),
    replay: Schema.Literal('allowed'),
  }),
  Schema.Struct({
    state: Schema.Literal('acknowledged'),
    retry: Schema.Literal('forbidden'),
    reconnect: Schema.Literal('forbidden'),
    replay: Schema.Literal('forbidden'),
  }),
]);

const webSocketEvidenceEventSchema = Schema.Struct({
  classification: webSocketEvidenceClassificationSchema,
  elapsed_ms: nonnegativeIntegerSchema,
  request_id: Schema.optional(requestIdSchema),
  message_bytes: Schema.optional(nonnegativeIntegerSchema),
  excerpt: Schema.optional(rawExcerptSchema),
});

const webSocketCloseEvidenceSchema = Schema.Struct({
  code: Schema.optional(
    safeIntegerSchema
      .check(Schema.isGreaterThanOrEqualTo(1_000))
      .check(Schema.isLessThanOrEqualTo(4_999)),
  ),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(123))),
  clean: Schema.Boolean,
});

const webSocketEvidenceBaseFields = {
  schema: Schema.Literal(WEBSOCKET_EVIDENCE_SCHEMA_ID),
  request_id: requestIdSchema,
  lifecycle: webSocketLifecycleSchema,
  connection_mode: webSocketConnectionModeSchema,
  acknowledgement: webSocketAcknowledgementEvidenceSchema,
  events: Schema.Array(webSocketEvidenceEventSchema).check(Schema.isMaxLength(1_024)),
  close: Schema.optional(webSocketCloseEvidenceSchema),
};

/**
 * Persists bounded/redacted WebSocket decisions with a stable terminal classification.
 * Acknowledgement state makes the no-replay boundary machine-checkable on every attempt.
 */
const webSocketAttemptEvidenceSchema = Schema.Union([
  Schema.Struct({
    ...webSocketEvidenceBaseFields,
    outcome: Schema.Literal('completed'),
  }),
  Schema.Struct({
    ...webSocketEvidenceBaseFields,
    outcome: Schema.Literal('failed'),
    error_classification: webSocketErrorClassificationSchema,
  }),
  Schema.Struct({
    ...webSocketEvidenceBaseFields,
    outcome: Schema.Literal('cancelled'),
    error_classification: Schema.Literal('cancelled'),
  }),
]);

type WebSocketAttemptEvidence = typeof webSocketAttemptEvidenceSchema.Type;

type WebSocketErrorClassification = typeof webSocketErrorClassificationSchema.Type;

export {
  webSocketAttemptEvidenceSchema,
  webSocketErrorClassificationSchema,
  webSocketEvidenceClassificationSchema,
  type WebSocketAttemptEvidence,
  type WebSocketErrorClassification,
};
