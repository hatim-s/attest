import * as Schema from 'effect/Schema';

import { mutationEnvelopeFields, requestSchemaField } from './envelope.js';
import { metricResourceSchema } from '../../project/resources/metric.js';
import { resourceIdSchema } from '../../project/shared.js';

const metricAddRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('metric.add'),
  metric: metricResourceSchema,
});

const metricImportRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('metric.import'),
  source: Schema.String.check(Schema.isMinLength(1)),
  source_type: Schema.Literal('json'),
  as: resourceIdSchema,
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});

const metricTestRequestSchema = Schema.Struct({
  ...requestSchemaField,
  command: Schema.Literal('metric.test'),
  metric_id: resourceIdSchema,
  fixture: Schema.String.check(Schema.isMinLength(1)),
});

const metricRenameRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('metric.rename'),
  metric_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const metricRemoveRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('metric.remove'),
  metric_id: resourceIdSchema,
  detach: Schema.optional(Schema.Boolean),
});

export {
  metricAddRequestSchema,
  metricImportRequestSchema,
  metricRemoveRequestSchema,
  metricRenameRequestSchema,
  metricTestRequestSchema,
};
