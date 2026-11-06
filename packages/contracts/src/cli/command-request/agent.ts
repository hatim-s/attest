import { positiveIntegerSchema } from '../../schema/scalars.js';
import * as Schema from 'effect/Schema';

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

const agentAddRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('agent.add'),
  agent: agentResourceSchema,
});

/** Encodes the optional asynchronous polling mapping selected during one cURL import. */
const curlPollingImportSchema = Schema.Struct({
  idempotency_header: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  job_id_pointer: jsonPointerSchema,
  status_url_pointer: Schema.optional(jsonPointerSchema),
  status_url_template: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  status_pointer: jsonPointerSchema,
  success_values: Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  failure_values: Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  minimum_interval_ms: positiveIntegerSchema,
  maximum_interval_ms: positiveIntegerSchema,
}).check(
  Schema.makeFilter((value) => {
    const issues: Schema.FilterIssue[] = [];
    refinePollingSchedule(value, issues);

    return issues;
  }),
);

const agentImportFields = {
  ...mutationEnvelopeFields,
  command: Schema.Literal('agent.import'),
  source: Schema.String.check(Schema.isMinLength(1)),
  as: resourceIdSchema,
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
};

const agentImportRequestSchema = Schema.Union([
  Schema.Struct({ ...agentImportFields, source_type: Schema.Literal('json') }),
  Schema.Struct({
    ...agentImportFields,
    source_type: Schema.Literal('curl'),
    placeholders: Schema.optional(
      Schema.Array(
        Schema.Struct({
          target_pointer: jsonPointerSchema,
          input_pointer: jsonPointerSchema,
        }),
      ),
    ),
    header_env: Schema.optional(
      Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1))),
    ),
    query_env: Schema.optional(
      Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1))),
    ),
    extraction: responseExtractionSchema,
    polling: Schema.optional(curlPollingImportSchema),
    timeouts: Schema.optional(agentTimeoutPolicySchema),
    retry: Schema.optional(retryPolicySchema),
    limits: Schema.optional(agentEvidenceLimitsSchema),
  }),
]);

const agentRenameRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('agent.rename'),
  agent_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const agentRemoveRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('agent.remove'),
  agent_id: resourceIdSchema,
  detach: Schema.optional(Schema.Boolean),
});

const agentTestRequestSchema = Schema.Struct({
  ...requestSchemaField,
  command: Schema.Literal('agent.test'),
  agent_id: resourceIdSchema,
  input: Schema.Json,
  record: Schema.optional(Schema.Boolean),
});

export {
  agentAddRequestSchema,
  agentImportRequestSchema,
  agentRemoveRequestSchema,
  agentRenameRequestSchema,
  agentTestRequestSchema,
};
