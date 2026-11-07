import * as Schema from 'effect/Schema';

import { httpRequestTemplateSchema } from './agent-transports.js';
import { assertionCheckSchema } from '../../metric/protocol.js';
import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  relativePathSchema,
  resourceIdSchema,
  retryPolicySchema,
  secretReferenceSchema,
} from '../shared.js';
import { METRIC_RESOURCE_SCHEMA_ID } from '../../schema/identifiers.js';

const assertionMetricSchema = Schema.Struct({
  kind: Schema.Literal('assertion'),
  assertions: Schema.Array(assertionCheckSchema).check(Schema.isMinLength(1)),
});

const judgeMetricSchema = Schema.Struct({
  kind: Schema.Literal('judge'),
  model: Schema.String.check(Schema.isMinLength(1)),
  rubric: Schema.String.check(Schema.isMinLength(1)),
  threshold: Schema.Finite.check(Schema.isFinite()),
});

const executableMetricSchema = Schema.Struct({
  kind: Schema.Literal('exec'),
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  cwd: Schema.optional(relativePathSchema),
  env: Schema.optional(Schema.Record(Schema.String, secretReferenceSchema)),
  timeout_ms: Schema.optional(durationMillisecondsSchema),
});

/** Extracts the normalized metric result envelope from an HTTP response. */
const metricResultExtractionSchema = Schema.Struct({
  score_pointer: jsonPointerSchema,
  pass_pointer: jsonPointerSchema,
  rationale_pointer: Schema.optional(jsonPointerSchema),
  details_pointer: Schema.optional(jsonPointerSchema),
});

const httpMetricSchema = Schema.Struct({
  kind: Schema.Literal('http'),
  request: httpRequestTemplateSchema,
  extraction: metricResultExtractionSchema,
  timeout_ms: Schema.optional(durationMillisecondsSchema),
  retry: Schema.optional(retryPolicySchema),
});

/** Encodes one canonical assertion, judge, executable, or HTTP metric resource. */
const metricResourceSchema = Schema.Struct({
  schema: Schema.Literal(METRIC_RESOURCE_SCHEMA_ID),
  id: resourceIdSchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  definition: Schema.Union([
    assertionMetricSchema,
    judgeMetricSchema,
    executableMetricSchema,
    httpMetricSchema,
  ]),
}).annotate({ identifier: 'MetricResource' });

type MetricResource = typeof metricResourceSchema.Type;

type MetricResultExtraction = typeof metricResultExtractionSchema.Type;

export {
  metricResourceSchema,
  metricResultExtractionSchema,
  type MetricResource,
  type MetricResultExtraction,
};
