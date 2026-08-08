import { z } from 'zod';

import { agentRequestSchema, agentResponseSchema } from './agent.js';

const requestIdSchema = z.string().min(1).max(256);

/** Frames one native agent request for a persistent JSONL bridge. */
const jsonlBridgeRequestSchema = z.strictObject({
  type: z.literal('request'),
  request_id: requestIdSchema,
  request: agentRequestSchema,
});

/** Requests per-case cancellation without disturbing other multiplexed work. */
const jsonlBridgeCancelSchema = z.strictObject({
  type: z.literal('cancel'),
  request_id: requestIdSchema,
});

/** Correlates one native agent response with the request that produced it. */
const jsonlBridgeResponseSchema = z.strictObject({
  type: z.literal('response'),
  request_id: requestIdSchema,
  response: agentResponseSchema,
});

/** Optionally acknowledges that a bridge settled an in-band cancellation. */
const jsonlBridgeCancelledSchema = z.strictObject({
  type: z.literal('cancelled'),
  request_id: requestIdSchema,
});

const jsonlBridgeInputSchema = z.discriminatedUnion('type', [
  jsonlBridgeRequestSchema,
  jsonlBridgeCancelSchema,
]);
const jsonlBridgeOutputSchema = z.discriminatedUnion('type', [
  jsonlBridgeResponseSchema,
  jsonlBridgeCancelledSchema,
]);

type JsonlBridgeInput = z.infer<typeof jsonlBridgeInputSchema>;
type JsonlBridgeOutput = z.infer<typeof jsonlBridgeOutputSchema>;

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
