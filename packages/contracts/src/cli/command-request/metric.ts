import { z } from 'zod';

import { mutationEnvelopeFields, requestSchemaField } from './envelope.js';
import { metricResourceSchema } from '../../project/resources/metric.js';
import { resourceIdSchema } from '../../project/shared.js';

const metricAddRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('metric.add'),
  metric: metricResourceSchema,
});

const metricImportRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('metric.import'),
  source: z.string().min(1),
  source_type: z.literal('json'),
  as: resourceIdSchema,
  name: z.string().min(1).optional(),
});

const metricTestRequestSchema = z.strictObject({
  ...requestSchemaField,
  command: z.literal('metric.test'),
  metric_id: resourceIdSchema,
  fixture: z.string().min(1),
});

const metricRenameRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('metric.rename'),
  metric_id: resourceIdSchema,
  new_id: resourceIdSchema,
});

const metricRemoveRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('metric.remove'),
  metric_id: resourceIdSchema,
  detach: z.boolean().optional(),
});

export {
  metricAddRequestSchema,
  metricImportRequestSchema,
  metricRemoveRequestSchema,
  metricRenameRequestSchema,
  metricTestRequestSchema,
};
