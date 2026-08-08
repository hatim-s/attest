import { z } from 'zod';

import { testCaseSchema } from './case-v2.js';
import { traceSchema } from './trace.js';
import { METRIC_TEST_FIXTURE_SCHEMA_VERSION } from './versions.js';

/** Encodes one local, network-free case result consumed only by `attest metric test`. */
const metricTestFixtureSchema = z
  .strictObject({
    schema: z.literal(METRIC_TEST_FIXTURE_SCHEMA_VERSION),
    case: testCaseSchema,
    expected_pass: z.boolean(),
    output: z.json(),
    trace: traceSchema.nullable(),
  })
  .meta({ id: 'MetricTestFixture' });

type MetricTestFixture = z.infer<typeof metricTestFixtureSchema>;

export { metricTestFixtureSchema, type MetricTestFixture };
