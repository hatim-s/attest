import { z } from 'zod';

import { mutationEnvelopeFields, requestSchemaField } from './envelope.js';
import {
  agentEvidenceLimitsSchema,
  agentResourceSchema,
  agentTimeoutPolicySchema,
} from '../../project/resources/agent.js';
import { responseExtractionSchema } from '../../project/resources/agent-transports.js';
import {
  jsonPointerSchema,
  refinePollingSchedule,
  resourceIdSchema,
  retryPolicySchema,
} from '../../project/shared.js';

const agentAddRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('agent.add'),
  agent: agentResourceSchema,
});

/** Encodes the optional asynchronous polling mapping selected during one cURL import. */
const curlPollingImportSchema = z
  .strictObject({
    idempotency_header: z.string().min(1).optional(),
    job_id_pointer: jsonPointerSchema,
    status_url_pointer: jsonPointerSchema.optional(),
    status_url_template: z.string().min(1).optional(),
    status_pointer: jsonPointerSchema,
    success_values: z.array(z.json()).nonempty(),
    failure_values: z.array(z.json()).nonempty(),
    minimum_interval_ms: z.number().int().positive(),
    maximum_interval_ms: z.number().int().positive(),
  })
  .superRefine(refinePollingSchedule);

const agentImportFields = {
  ...mutationEnvelopeFields,
  command: z.literal('agent.import'),
  source: z.string().min(1),
  as: resourceIdSchema,
  name: z.string().min(1).optional(),
};

const agentImportRequestSchema = z.discriminatedUnion('source_type', [
  z.strictObject({ ...agentImportFields, source_type: z.literal('json') }),
  z.strictObject({
    ...agentImportFields,
    source_type: z.literal('curl'),
    placeholders: z
      .array(
        z.strictObject({
          target_pointer: jsonPointerSchema,
          input_pointer: jsonPointerSchema,
        }),
      )
      .optional(),
    header_env: z.record(z.string(), z.string().min(1)).optional(),
    query_env: z.record(z.string(), z.string().min(1)).optional(),
    extraction: responseExtractionSchema,
    polling: curlPollingImportSchema.optional(),
    timeouts: agentTimeoutPolicySchema.optional(),
    retry: retryPolicySchema.optional(),
    limits: agentEvidenceLimitsSchema.optional(),
  }),
]);

const agentRenameRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('agent.rename'),
  agent_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const agentRemoveRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('agent.remove'),
  agent_id: resourceIdSchema,
  detach: z.boolean().optional(),
});

const agentTestRequestSchema = z.strictObject({
  ...requestSchemaField,
  command: z.literal('agent.test'),
  agent_id: resourceIdSchema,
  input: z.json(),
  record: z.boolean().optional(),
});

export {
  agentAddRequestSchema,
  agentImportRequestSchema,
  agentRemoveRequestSchema,
  agentRenameRequestSchema,
  agentTestRequestSchema,
};
