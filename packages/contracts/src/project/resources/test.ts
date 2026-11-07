import { nonnegativeIntegerSchema } from '../../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { testCaseSchema } from './case.js';
import { executionDefaultsSchema, resourceIdSchema } from '../shared.js';
import { TEST_RESOURCE_SCHEMA_ID } from '../../schema/identifiers.js';

/** References one reusable dataset and an optional all-tags attachment filter. */
const datasetAttachmentSchema = Schema.Struct({
  dataset_id: resourceIdSchema,
  tags: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
});

/** Attaches a reusable metric with an optional test-level pass threshold. */
const testMetricReferenceSchema = Schema.Struct({
  metric_id: resourceIdSchema,
  threshold: Schema.optional(Schema.Finite.check(Schema.isFinite())),
});

/** Defines optional gates applied after every selected case has settled. */
const testPassGateSchema = Schema.Struct({
  minimum_pass_rate: Schema.optional(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(1)),
  ),
  maximum_failed_cases: Schema.optional(nonnegativeIntegerSchema),
  require_all_metrics: Schema.optional(Schema.Boolean),
});

/** Encodes one canonical test resource and its direct case definitions. */
const testResourceSchema = Schema.Struct({
  schema: Schema.Literal(TEST_RESOURCE_SCHEMA_ID),
  id: resourceIdSchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  agent_id: resourceIdSchema,
  cases: Schema.Array(testCaseSchema),
  datasets: Schema.Array(datasetAttachmentSchema),
  metrics: Schema.Array(testMetricReferenceSchema),
  defaults: Schema.optional(executionDefaultsSchema),
  pass_gate: Schema.optional(testPassGateSchema),
}).annotate({ identifier: 'TestResource' });

type DatasetAttachment = typeof datasetAttachmentSchema.Type;

type TestMetricReference = typeof testMetricReferenceSchema.Type;

type TestPassGate = typeof testPassGateSchema.Type;

type TestResource = typeof testResourceSchema.Type;

export {
  datasetAttachmentSchema,
  testMetricReferenceSchema,
  testPassGateSchema,
  testResourceSchema,
  type DatasetAttachment,
  type TestMetricReference,
  type TestPassGate,
  type TestResource,
};
