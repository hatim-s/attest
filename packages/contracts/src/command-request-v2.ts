import { z } from 'zod';

import { agentResourceSchema, responseExtractionSchema } from './agent-resource-v2.js';
import { testCaseSchema } from './case-v2.js';
import { datasetResourceSchema } from './dataset-resource-v2.js';
import { metricResourceSchema } from './metric-resource-v2.js';
import { testResourceSchema } from './test-resource-v2.js';
import { jsonPointerSchema, resourceIdSchema, sha256Schema } from './v2-shared.js';
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

/** Publishes only the native append-only import surface owned by CLI2.7. */
const caseImportOptionsSchema = z.strictObject({
  format: z.enum(['json', 'jsonl']).optional(),
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
    extraction: responseExtractionSchema,
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
]);

type CaseImportOptions = z.infer<typeof caseImportOptionsSchema>;
type CommandRequest = z.infer<typeof commandRequestSchema>;

export {
  caseImportOptionsSchema,
  commandRequestSchema,
  type CaseImportOptions,
  type CommandRequest,
};
