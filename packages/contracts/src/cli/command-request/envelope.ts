import * as Schema from 'effect/Schema';

import { sha256Schema } from '../../project/shared.js';
import { COMMAND_REQUEST_SCHEMA_ID } from '../../schema/identifiers.js';

/** Identifies a --from-json document; the only envelope field read-only commands accept. */
const requestSchemaField = { schema: Schema.Literal(COMMAND_REQUEST_SCHEMA_ID) };

/**
 * Envelope for commands that change project files. `agent.test` and `metric.test` never write,
 * so they take only `requestSchemaField`.
 */
const mutationEnvelopeFields = {
  ...requestSchemaField,
  dry_run: Schema.optional(Schema.Boolean),
  yes: Schema.optional(Schema.Boolean),
  if_project_hash: Schema.optional(sha256Schema),
};

export { mutationEnvelopeFields, requestSchemaField };
