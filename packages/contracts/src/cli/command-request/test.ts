import * as Struct from 'effect/Struct';
import * as Schema from 'effect/Schema';

import { mutationEnvelopeFields } from './envelope.js';
import { testCaseSchema } from '../../project/resources/case.js';
import {
  datasetImportMappingSchema,
  datasetResourceSchema,
} from '../../project/resources/dataset.js';
import { testResourceSchema } from '../../project/resources/test.js';
import { jsonPointerSchema, resourceIdSchema } from '../../project/shared.js';

/** Accepts an optional id at the authoring boundary so every input route can generate one. */
const authoringTestCaseSchema = Schema.Struct({
  ...Struct.omit(testCaseSchema.fields, ['id']),
  id: Schema.optional(resourceIdSchema),
});

const importFormatSchema = Schema.Literals(['csv', 'json', 'jsonl']);

const importDedupePolicySchema = Schema.Literals(['id', 'key', 'content']);

const importConflictPolicySchema = Schema.Literals(['error', 'skip', 'update']);

const importSyncPolicySchema = Schema.Literals(['append', 'upsert']);

/** Encodes the complete deterministic CSV/JSON/JSONL import policy shared by case and dataset imports. */
const caseImportOptionsSchema = Schema.Struct({
  format: Schema.optional(importFormatSchema),
  mapping: Schema.optional(Schema.Array(datasetImportMappingSchema)),
  parse_json: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  records_pointer: Schema.optional(jsonPointerSchema),
  key: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  dedupe: Schema.optional(importDedupePolicySchema),
  on_conflict: Schema.optional(importConflictPolicySchema),
  sync: Schema.optional(importSyncPolicySchema),
});

const testAddRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.add'),
  test: testResourceSchema,
});

const testCaseAddRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.case.add'),
  test_id: resourceIdSchema,
  case: authoringTestCaseSchema,
});

const testCaseImportRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.case.import'),
  test_id: resourceIdSchema,
  source: Schema.String.check(Schema.isMinLength(1)),
  import: caseImportOptionsSchema,
});

const testCaseRenameRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.case.rename'),
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testCaseRemoveRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.case.remove'),
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
});

/** Accepts only the empty native dataset shape that `test dataset add` can author. */
const testDatasetAddResourceSchema = Schema.Struct({
  ...Struct.omit(datasetResourceSchema.fields, ['case_count', 'provenance']),
  case_count: Schema.Literal(0),
});

const testDatasetAddRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.dataset.add'),
  test_id: resourceIdSchema,
  dataset: testDatasetAddResourceSchema,
});

const testDatasetImportRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.dataset.import'),
  test_id: resourceIdSchema,
  source: Schema.String.check(Schema.isMinLength(1)),
  as: resourceIdSchema,
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  import: caseImportOptionsSchema,
});

const testDatasetAttachRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.dataset.attach'),
  test_id: resourceIdSchema,
  dataset_id: resourceIdSchema,
  tags: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
});

const testDatasetDetachRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.dataset.detach'),
  test_id: resourceIdSchema,
  dataset_id: resourceIdSchema,
});

const testDatasetRenameRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.dataset.rename'),
  dataset_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testDatasetRemoveRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.dataset.remove'),
  dataset_id: resourceIdSchema,
});

const testMetricAttachRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.metric.attach'),
  test_id: resourceIdSchema,
  metric_id: resourceIdSchema,
  threshold: Schema.optional(Schema.Finite.check(Schema.isFinite())),
});

const testMetricDetachRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.metric.detach'),
  test_id: resourceIdSchema,
  metric_id: resourceIdSchema,
});

const testRenameRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.rename'),
  test_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const testRemoveRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('test.remove'),
  test_id: resourceIdSchema,
});

type CaseImportOptions = typeof caseImportOptionsSchema.Type;

type ImportFormat = typeof importFormatSchema.Type;

type ImportDedupePolicy = typeof importDedupePolicySchema.Type;

type ImportConflictPolicy = typeof importConflictPolicySchema.Type;

type ImportSyncPolicy = typeof importSyncPolicySchema.Type;

export {
  caseImportOptionsSchema,
  importConflictPolicySchema,
  importDedupePolicySchema,
  importFormatSchema,
  importSyncPolicySchema,
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
  type ImportConflictPolicy,
  type ImportDedupePolicy,
  type ImportFormat,
  type ImportSyncPolicy,
};
