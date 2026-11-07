import * as Schema from 'effect/Schema';

import { cliFailureResultSchema, cliSuccessResultSchema } from '../cli/protocol.js';
import { evalRunIdSchema } from './run.js';
import { COMMAND_REQUEST_SCHEMA_ID } from '../schema/identifiers.js';

/** Encodes the only JSON request accepted by `attest eval cancel`. */
const evalCancelRequestSchema = Schema.Struct({
  schema: Schema.Literal(COMMAND_REQUEST_SCHEMA_ID),
  command: Schema.Literal('eval.cancel'),
  run_id: evalRunIdSchema,
  output: Schema.Literals(['human', 'json']),
});

const evalCancelResultPayloadSchema = Schema.Struct({
  run_id: evalRunIdSchema,
  status: Schema.Literals(['cancellation_requested', 'already_cancelled', 'already_terminal']),
});

const evalCancelSuccessResultSchema = Schema.Struct({
  ...cliSuccessResultSchema.fields,
  command: Schema.Literal('eval.cancel'),
  result: evalCancelResultPayloadSchema,
});

const evalCancelFailureResultSchema = Schema.Struct({
  ...cliFailureResultSchema.fields,
  command: Schema.Literal('eval.cancel'),
});

/** Narrows the shared CLI result envelope to cancellation-specific success data. */
const evalCancelResultSchema = Schema.Union([
  evalCancelSuccessResultSchema,
  evalCancelFailureResultSchema,
]);

type EvalCancelRequest = typeof evalCancelRequestSchema.Type;

type EvalCancelResult = typeof evalCancelResultSchema.Type;

type EvalCancelResultPayload = typeof evalCancelResultPayloadSchema.Type;

export {
  evalCancelRequestSchema,
  evalCancelResultPayloadSchema,
  evalCancelResultSchema,
  type EvalCancelRequest,
  type EvalCancelResult,
  type EvalCancelResultPayload,
};
