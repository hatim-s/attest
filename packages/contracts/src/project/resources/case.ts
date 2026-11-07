import * as Schema from 'effect/Schema';

import { caseFolderSchema, resourceIdSchema } from '../shared.js';

/** Overrides one attached metric for a particular case without copying its definition. */
const caseMetricOverrideSchema = Schema.Struct({
  metric_id: resourceIdSchema,
  enabled: Schema.optional(Schema.Boolean),
  threshold: Schema.optional(Schema.Finite.check(Schema.isFinite())),
});

/** Encodes the logical case shape shared by direct cases and dataset JSONL rows. */
const testCaseSchema = Schema.Struct({
  id: resourceIdSchema,
  input: Schema.Json,
  expected: Schema.optional(Schema.Json),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  tags: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  folder: Schema.optional(caseFolderSchema),
  metric_overrides: Schema.optional(Schema.Array(caseMetricOverrideSchema)),
}).annotate({ identifier: 'TestCase' });

type CaseMetricOverride = typeof caseMetricOverrideSchema.Type;

type TestCase = typeof testCaseSchema.Type;

export { caseMetricOverrideSchema, testCaseSchema, type CaseMetricOverride, type TestCase };
