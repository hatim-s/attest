import { z } from 'zod';

import { cliFailureResultSchema, cliSuccessResultSchema } from '../cli/protocol.js';
import { evalRunIdSchema } from './run.js';
import { COMMAND_REQUEST_SCHEMA_ID, currentOrLegacyIdentifier } from '../schema/identifiers.js';

/** Encodes the only JSON request accepted by `attest eval cancel`. */
const evalCancelRequestSchema = z.strictObject({
  schema: currentOrLegacyIdentifier(COMMAND_REQUEST_SCHEMA_ID, 'attest.command-request/v2'),
  command: z.literal('eval.cancel'),
  run_id: evalRunIdSchema,
  output: z.enum(['human', 'json']),
});

const evalCancelResultPayloadSchema = z.strictObject({
  run_id: evalRunIdSchema,
  status: z.enum(['cancellation_requested', 'already_cancelled', 'already_terminal']),
});

const evalCancelSuccessResultSchema = cliSuccessResultSchema.extend({
  command: z.literal('eval.cancel'),
  result: evalCancelResultPayloadSchema,
});

const evalCancelFailureResultSchema = cliFailureResultSchema.extend({
  command: z.literal('eval.cancel'),
});

/** Narrows the shared CLI result envelope to cancellation-specific success data. */
const evalCancelResultSchema = z.union([
  evalCancelSuccessResultSchema,
  evalCancelFailureResultSchema,
]);

type EvalCancelRequest = z.infer<typeof evalCancelRequestSchema>;
type EvalCancelResult = z.infer<typeof evalCancelResultSchema>;
type EvalCancelResultPayload = z.infer<typeof evalCancelResultPayloadSchema>;

export {
  evalCancelRequestSchema,
  evalCancelResultPayloadSchema,
  evalCancelResultSchema,
  type EvalCancelRequest,
  type EvalCancelResult,
  type EvalCancelResultPayload,
};
