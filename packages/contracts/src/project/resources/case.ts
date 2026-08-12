import { z } from 'zod';

import { resourceIdSchema } from '../shared.js';

/** Overrides one attached metric for a particular case without copying its definition. */
const caseMetricOverrideSchema = z.strictObject({
  metric_id: resourceIdSchema,
  enabled: z.boolean().optional(),
  threshold: z.number().finite().optional(),
});

/** Encodes the logical case shape shared by direct cases and dataset JSONL rows. */
const testCaseSchema = z
  .strictObject({
    id: resourceIdSchema,
    input: z.json(),
    expected: z.json().optional(),
    params: z.record(z.string(), z.json()).optional(),
    tags: z.array(z.string().min(1)).optional(),
    metric_overrides: z.array(caseMetricOverrideSchema).optional(),
  })
  .meta({ id: 'TestCase' });

type CaseMetricOverride = z.infer<typeof caseMetricOverrideSchema>;
type TestCase = z.infer<typeof testCaseSchema>;

export { caseMetricOverrideSchema, testCaseSchema, type CaseMetricOverride, type TestCase };
