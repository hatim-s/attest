import * as Schema from 'effect/Schema';

import { agentRequestSchema, agentResponseSchema } from './protocol.js';
import { requestIdSchema } from '../project/shared.js';

/** Frames one native agent request for a persistent JSONL bridge. */
const jsonlBridgeRequestSchema = Schema.Struct({
  type: Schema.Literal('request'),
  request_id: requestIdSchema,
  request: agentRequestSchema,
});

/** Requests per-case cancellation without disturbing other multiplexed work. */
const jsonlBridgeCancelSchema = Schema.Struct({
  type: Schema.Literal('cancel'),
  request_id: requestIdSchema,
});

/** Correlates one native agent response with the request that produced it. */
const jsonlBridgeResponseSchema = Schema.Struct({
  type: Schema.Literal('response'),
  request_id: requestIdSchema,
  response: agentResponseSchema,
});

/** Optionally acknowledges that a bridge settled an in-band cancellation. */
const jsonlBridgeCancelledSchema = Schema.Struct({
  type: Schema.Literal('cancelled'),
  request_id: requestIdSchema,
});

const jsonlBridgeInputSchema = Schema.Union([jsonlBridgeRequestSchema, jsonlBridgeCancelSchema]);

const jsonlBridgeOutputSchema = Schema.Union([
  jsonlBridgeResponseSchema,
  jsonlBridgeCancelledSchema,
]);

type JsonlBridgeInput = typeof jsonlBridgeInputSchema.Type;

type JsonlBridgeOutput = typeof jsonlBridgeOutputSchema.Type;

export {
  jsonlBridgeCancelSchema,
  jsonlBridgeCancelledSchema,
  jsonlBridgeInputSchema,
  jsonlBridgeOutputSchema,
  jsonlBridgeRequestSchema,
  jsonlBridgeResponseSchema,
  type JsonlBridgeInput,
  type JsonlBridgeOutput,
};
