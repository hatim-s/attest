import { z } from 'zod';

import { testCaseSchema } from './case.js';
import { executionDefaultsSchema, resourceIdSchema } from '../shared.js';
import {
  TEST_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_VERSION,
  currentOrLegacyIdentifier,
} from '../../schema/identifiers.js';

/** References one reusable dataset and an optional all-tags attachment filter. */
const datasetAttachmentSchema = z.strictObject({
  dataset_id: resourceIdSchema,
  tags: z.array(z.string().min(1)).optional(),
});

/** Attaches a reusable metric with an optional test-level pass threshold. */
const testMetricReferenceSchema = z.strictObject({
  metric_id: resourceIdSchema,
  threshold: z.number().finite().optional(),
});

/** Defines optional gates applied after every selected case has settled. */
const testPassGateSchema = z.strictObject({
  minimum_pass_rate: z.number().min(0).max(1).optional(),
  maximum_failed_cases: z.number().int().nonnegative().optional(),
  require_all_metrics: z.boolean().optional(),
});

/** Encodes one canonical test resource and its direct case definitions. */
const testResourceSchema = z
  .strictObject({
    schema: currentOrLegacyIdentifier(TEST_RESOURCE_SCHEMA_ID, TEST_RESOURCE_SCHEMA_VERSION),
    id: resourceIdSchema,
    name: z.string().min(1),
    agent_id: resourceIdSchema,
    cases: z.array(testCaseSchema),
    datasets: z.array(datasetAttachmentSchema),
    metrics: z.array(testMetricReferenceSchema),
    defaults: executionDefaultsSchema.optional(),
    pass_gate: testPassGateSchema.optional(),
  })
  .meta({ id: 'TestResource' });

type DatasetAttachment = z.infer<typeof datasetAttachmentSchema>;
type TestMetricReference = z.infer<typeof testMetricReferenceSchema>;
type TestPassGate = z.infer<typeof testPassGateSchema>;
type TestResource = z.infer<typeof testResourceSchema>;

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
