import { z } from 'zod';

import { mutationEnvelopeFields } from './envelope.js';
import { testCaseSchema } from '../../project/resources/case.js';
import {
  datasetImportMappingSchema,
  datasetResourceSchema,
} from '../../project/resources/dataset.js';
import { testResourceSchema } from '../../project/resources/test.js';
import { jsonPointerSchema, resourceIdSchema } from '../../project/shared.js';

/** Accepts an optional id at the authoring boundary so every input route can generate one. */
const authoringTestCaseSchema = testCaseSchema
  .omit({ id: true })
  .extend({ id: resourceIdSchema.optional() });

/** Encodes the complete deterministic CSV/JSON/JSONL import policy shared by case and dataset imports. */
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

const testAddRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.add'),
  test: testResourceSchema,
});

const testCaseAddRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.case.add'),
  test_id: resourceIdSchema,
  case: authoringTestCaseSchema,
});

const testCaseImportRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.case.import'),
  test_id: resourceIdSchema,
  source: z.string().min(1),
  import: caseImportOptionsSchema,
});

const testCaseRenameRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.case.rename'),
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testCaseRemoveRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.case.remove'),
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
});

/** Accepts only the empty native dataset shape that `test dataset add` can author. */
const testDatasetAddResourceSchema = datasetResourceSchema
  .omit({ case_count: true, provenance: true })
  .extend({ case_count: z.literal(0) });

const testDatasetAddRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.dataset.add'),
  test_id: resourceIdSchema,
  dataset: testDatasetAddResourceSchema,
});

const testDatasetImportRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.dataset.import'),
  test_id: resourceIdSchema,
  source: z.string().min(1),
  as: resourceIdSchema,
  name: z.string().min(1).optional(),
  import: caseImportOptionsSchema,
});

const testDatasetAttachRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.dataset.attach'),
  test_id: resourceIdSchema,
  dataset_id: resourceIdSchema,
  tags: z.array(z.string().min(1)).optional(),
});

const testDatasetDetachRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.dataset.detach'),
  test_id: resourceIdSchema,
  dataset_id: resourceIdSchema,
});

const testDatasetRenameRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.dataset.rename'),
  dataset_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testDatasetRemoveRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.dataset.remove'),
  dataset_id: resourceIdSchema,
});

const testMetricAttachRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.metric.attach'),
  test_id: resourceIdSchema,
  metric_id: resourceIdSchema,
  threshold: z.number().finite().optional(),
});

const testMetricDetachRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.metric.detach'),
  test_id: resourceIdSchema,
  metric_id: resourceIdSchema,
});

const testRenameRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.rename'),
  test_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testRemoveRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('test.remove'),
  test_id: resourceIdSchema,
});

type CaseImportOptions = z.infer<typeof caseImportOptionsSchema>;

export {
  caseImportOptionsSchema,
  testAddRequestSchema,
  testCaseAddRequestSchema,
  testCaseImportRequestSchema,
  testCaseRemoveRequestSchema,
  testCaseRenameRequestSchema,
  testDatasetAddRequestSchema,
  testDatasetAttachRequestSchema,
  testDatasetDetachRequestSchema,
  testDatasetImportRequestSchema,
  testDatasetRemoveRequestSchema,
  testDatasetRenameRequestSchema,
  testMetricAttachRequestSchema,
  testMetricDetachRequestSchema,
  testRemoveRequestSchema,
  testRenameRequestSchema,
  type CaseImportOptions,
};
