import { z } from 'zod';

import { mutationEnvelopeFields } from './envelope.js';

const projectInitRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('project.init'),
  directory: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

const projectUnlockRequestSchema = z.strictObject({
  ...mutationEnvelopeFields,
  command: z.literal('project.unlock'),
  stale: z.literal(true),
});

export { projectInitRequestSchema, projectUnlockRequestSchema };
