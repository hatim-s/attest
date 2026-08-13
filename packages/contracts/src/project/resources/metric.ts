import { z } from 'zod';

import { httpRequestTemplateSchema } from './agent.js';
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

const assertionMetricSchema = z.strictObject({
  kind: z.literal('assertion'),
  assertions: z.array(assertionCheckSchema).nonempty(),
});

const judgeMetricSchema = z.strictObject({
  kind: z.literal('judge'),
  model: z.string().min(1),
  rubric: z.string().min(1),
  threshold: z.number().finite(),
});

const executableMetricSchema = z.strictObject({
  kind: z.literal('exec'),
  argv: z.array(z.string()).nonempty(),
  cwd: relativePathSchema.optional(),
  env: z.record(z.string(), secretReferenceSchema).optional(),
  timeout_ms: durationMillisecondsSchema.optional(),
});

/** Extracts the normalized metric result envelope from an HTTP response. */
const metricResultExtractionSchema = z.strictObject({
  score_pointer: jsonPointerSchema,
  pass_pointer: jsonPointerSchema,
  rationale_pointer: jsonPointerSchema.optional(),
  details_pointer: jsonPointerSchema.optional(),
});

const httpMetricSchema = z.strictObject({
  kind: z.literal('http'),
  request: httpRequestTemplateSchema,
  extraction: metricResultExtractionSchema,
  timeout_ms: durationMillisecondsSchema.optional(),
  retry: retryPolicySchema.optional(),
});

/** Encodes one canonical assertion, judge, executable, or HTTP metric resource. */
const metricResourceSchema = z
  .strictObject({
    schema: z.literal(METRIC_RESOURCE_SCHEMA_ID),
    id: resourceIdSchema,
    name: z.string().min(1),
    definition: z.discriminatedUnion('kind', [
      assertionMetricSchema,
      judgeMetricSchema,
      executableMetricSchema,
      httpMetricSchema,
    ]),
  })
  .meta({ id: 'MetricResource' });

type MetricResource = z.infer<typeof metricResourceSchema>;
type MetricResultExtraction = z.infer<typeof metricResultExtractionSchema>;

export {
  metricResourceSchema,
  metricResultExtractionSchema,
  type MetricResource,
  type MetricResultExtraction,
};
