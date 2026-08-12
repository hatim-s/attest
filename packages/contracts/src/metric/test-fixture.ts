import { z } from 'zod';

import { testCaseSchema } from '../project/resources/case.js';
import { traceSchema } from '../trace/protocol.js';
import { METRIC_TEST_FIXTURE_SCHEMA_ID, currentOrLegacyIdentifier } from '../schema/identifiers.js';

/** Encodes one local, network-free case result consumed only by `attest metric test`. */
const metricTestFixtureSchema = z
  .strictObject({
    schema: currentOrLegacyIdentifier(
      METRIC_TEST_FIXTURE_SCHEMA_ID,
      'attest.metric-test-fixture/v1',
    ),
    case: testCaseSchema,
    expected_pass: z.boolean(),
    output: z.json(),
    trace: traceSchema.nullable(),
  })
  .meta({ id: 'MetricTestFixture' });

type MetricTestFixture = z.infer<typeof metricTestFixtureSchema>;

export { metricTestFixtureSchema, type MetricTestFixture };
