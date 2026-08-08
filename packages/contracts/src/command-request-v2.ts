import { z } from 'zod';

import {
  agentEvidenceLimitsSchema,
  agentResourceSchema,
  agentTimeoutPolicySchema,
  responseExtractionSchema,
} from './agent-resource-v2.js';
import { testCaseSchema } from './case-v2.js';
import { datasetImportMappingSchema, datasetResourceSchema } from './dataset-resource-v2.js';
import { evalCancelRequestSchema } from './eval-cancel-v1.js';
import { evalRunRequestSchema } from './eval-run-v1.js';
import { metricResourceSchema } from './metric-resource-v2.js';
import { testResourceSchema } from './test-resource-v2.js';
import {
  jsonPointerSchema,
  resourceIdSchema,
  retryPolicySchema,
  sha256Schema,
} from './v2-shared.js';
import { COMMAND_REQUEST_SCHEMA_VERSION } from './versions.js';

const commonMutationFields = {
  schema: z.literal(COMMAND_REQUEST_SCHEMA_VERSION),
  dry_run: z.boolean().optional(),
  yes: z.boolean().optional(),
  if_project_hash: sha256Schema.optional(),
};

/** Accepts an optional id at the authoring boundary so every input route can generate one. */
const authoringTestCaseSchema = testCaseSchema
  .omit({ id: true })
  .extend({ id: resourceIdSchema.optional() });

/** Encodes the complete deterministic CSV/JSON/JSONL import policy owned by CLI2.8. */
const caseImportOptionsSchema = z.strictObject({
  format: z.enum(['csv', 'json', 'jsonl']).optional(),
  mapping: z.array(datasetImportMappingSchema).optional(),
  parse_json: z.array(z.string().min(1)).optional(),
  records_pointer: jsonPointerSchema.optional(),
  key: z.string().min(1).optional(),
  dedupe: z.enum(['id', 'key', 'content']).optional(),
  on_conflict: z.enum(['error', 'skip', 'update']).optional(),
  sync: z.enum(['append', 'upsert']).optional(),
});

const projectInitRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('project.init'),
  directory: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

const projectUnlockRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('project.unlock'),
  stale: z.literal(true),
});

const agentAddRequestSchema = z.strictObject({
  ...commonMutationFields,
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
  .superRefine((polling, context) => {
    if (
      (polling.status_url_pointer === undefined) ===
      (polling.status_url_template === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status_url_pointer'],
        message: 'provide exactly one status URL pointer or template',
      });
    }
    if (polling.minimum_interval_ms > polling.maximum_interval_ms) {
      context.addIssue({
        code: 'custom',
        path: ['maximum_interval_ms'],
        message: 'must be greater than or equal to minimum_interval_ms',
      });
    }
  });

const agentImportRequestSchema = z.union([
  z.strictObject({
    ...commonMutationFields,
    command: z.literal('agent.import'),
    source: z.string().min(1),
    source_type: z.literal('json'),
    as: resourceIdSchema,
    name: z.string().min(1).optional(),
  }),
  z.strictObject({
    ...commonMutationFields,
    command: z.literal('agent.import'),
    source: z.string().min(1),
    source_type: z.literal('curl'),
    as: resourceIdSchema,
    name: z.string().min(1).optional(),
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
  ...commonMutationFields,
  command: z.literal('agent.rename'),
  agent_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const agentRemoveRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('agent.remove'),
  agent_id: resourceIdSchema,
  detach: z.boolean().optional(),
});

const agentTestRequestSchema = z.strictObject({
  schema: z.literal(COMMAND_REQUEST_SCHEMA_VERSION),
  command: z.literal('agent.test'),
  agent_id: resourceIdSchema,
  input: z.json(),
  record: z.boolean().optional(),
});

const testAddRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.add'),
  test: testResourceSchema,
});

const testCaseAddRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.case.add'),
  test_id: resourceIdSchema,
  case: authoringTestCaseSchema,
});

const testCaseImportRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.case.import'),
  test_id: resourceIdSchema,
  source: z.string().min(1),
  import: caseImportOptionsSchema,
});

const testCaseRenameRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.case.rename'),
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testCaseRemoveRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.case.remove'),
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
});

/** Accepts only the empty native dataset shape that `test dataset add` can author. */
const testDatasetAddResourceSchema = datasetResourceSchema
  .omit({ case_count: true, provenance: true })
  .extend({ case_count: z.literal(0) });

const testDatasetAddRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.dataset.add'),
  test_id: resourceIdSchema,
  dataset: testDatasetAddResourceSchema,
});

const testDatasetImportRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.dataset.import'),
  test_id: resourceIdSchema,
  source: z.string().min(1),
  as: resourceIdSchema,
  name: z.string().min(1).optional(),
  import: caseImportOptionsSchema,
});

const testDatasetAttachRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.dataset.attach'),
  test_id: resourceIdSchema,
  dataset_id: resourceIdSchema,
  tags: z.array(z.string().min(1)).optional(),
});

const testDatasetDetachRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.dataset.detach'),
  test_id: resourceIdSchema,
  dataset_id: resourceIdSchema,
});

const testDatasetRenameRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.dataset.rename'),
  dataset_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testDatasetRemoveRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.dataset.remove'),
  dataset_id: resourceIdSchema,
});

const testMetricAttachRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.metric.attach'),
  test_id: resourceIdSchema,
  metric_id: resourceIdSchema,
  threshold: z.number().finite().optional(),
});

const testMetricDetachRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.metric.detach'),
  test_id: resourceIdSchema,
  metric_id: resourceIdSchema,
});

const testRenameRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.rename'),
  test_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testRemoveRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('test.remove'),
  test_id: resourceIdSchema,
});

const metricAddRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('metric.add'),
  metric: metricResourceSchema,
});

const metricImportRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('metric.import'),
  source: z.string().min(1),
  source_type: z.literal('json'),
  as: resourceIdSchema,
  name: z.string().min(1).optional(),
});

const metricTestRequestSchema = z.strictObject({
  schema: z.literal(COMMAND_REQUEST_SCHEMA_VERSION),
  command: z.literal('metric.test'),
  metric_id: resourceIdSchema,
  fixture: z.string().min(1),
});

const metricRenameRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('metric.rename'),
  metric_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const metricRemoveRequestSchema = z.strictObject({
  ...commonMutationFields,
  command: z.literal('metric.remove'),
  metric_id: resourceIdSchema,
  detach: z.boolean().optional(),
});

/** Encodes every normalized v2 project-authoring request accepted through --from-json. */
const commandRequestSchema = z.union([
  projectInitRequestSchema,
  projectUnlockRequestSchema,
  agentAddRequestSchema,
  agentImportRequestSchema,
  agentRenameRequestSchema,
  agentRemoveRequestSchema,
  agentTestRequestSchema,
  testAddRequestSchema,
  testCaseAddRequestSchema,
  testCaseImportRequestSchema,
  testCaseRenameRequestSchema,
  testCaseRemoveRequestSchema,
  testDatasetAddRequestSchema,
  testDatasetImportRequestSchema,
  testDatasetAttachRequestSchema,
  testDatasetDetachRequestSchema,
  testDatasetRenameRequestSchema,
  testDatasetRemoveRequestSchema,
  testMetricAttachRequestSchema,
  testMetricDetachRequestSchema,
  testRenameRequestSchema,
  testRemoveRequestSchema,
  metricAddRequestSchema,
  metricImportRequestSchema,
  metricTestRequestSchema,
  metricRenameRequestSchema,
  metricRemoveRequestSchema,
  evalRunRequestSchema,
  evalCancelRequestSchema,
]);

type CaseImportOptions = z.infer<typeof caseImportOptionsSchema>;
type CommandRequest = z.infer<typeof commandRequestSchema>;

export {
  caseImportOptionsSchema,
  commandRequestSchema,
  type CaseImportOptions,
  type CommandRequest,
};
