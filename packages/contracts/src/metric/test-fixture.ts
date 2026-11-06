import * as Schema from 'effect/Schema';

import { inlineArtifactSchema } from '../agent/artifact.js';
import { testCaseSchema } from '../project/resources/case.js';
import { traceSchema } from '../trace/protocol.js';
import { METRIC_TEST_FIXTURE_SCHEMA_ID } from '../schema/identifiers.js';

/** Encodes one local, network-free case result consumed only by `attest metric test`. */
const metricTestFixtureSchema = Schema.Struct({
  schema: Schema.Literal(METRIC_TEST_FIXTURE_SCHEMA_ID),
  case: testCaseSchema,
  expected_pass: Schema.Boolean,
  output: Schema.Json,
  trace: Schema.NullOr(traceSchema),
  artifacts: Schema.optional(Schema.Array(inlineArtifactSchema)),
}).annotate({ identifier: 'MetricTestFixture' });

type MetricTestFixture = typeof metricTestFixtureSchema.Type;

export { metricTestFixtureSchema, type MetricTestFixture };
