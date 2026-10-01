import { z } from 'zod';

import { sha256Schema } from '../../project/shared.js';
import { COMMAND_REQUEST_SCHEMA_ID } from '../../schema/identifiers.js';

/** Identifies a --from-json document; the only envelope field read-only commands accept. */
const requestSchemaField = { schema: z.literal(COMMAND_REQUEST_SCHEMA_ID) };

/**
 * Envelope for commands that change project files. `agent.test` and `metric.test` never write,
 * so they take only `requestSchemaField`.
 */
const mutationEnvelopeFields = {
  ...requestSchemaField,
  dry_run: z.boolean().optional(),
  yes: z.boolean().optional(),
  if_project_hash: sha256Schema.optional(),
};

export { mutationEnvelopeFields, requestSchemaField };
