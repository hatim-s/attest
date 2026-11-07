import * as Schema from 'effect/Schema';

import { mutationEnvelopeFields } from './envelope.js';

const projectInitRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('project.init'),
  directory: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});

const projectUnlockRequestSchema = Schema.Struct({
  ...mutationEnvelopeFields,
  command: Schema.Literal('project.unlock'),
  stale: Schema.Literal(true),
});

export { projectInitRequestSchema, projectUnlockRequestSchema };
