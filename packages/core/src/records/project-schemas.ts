import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';

/** URL-safe project identifier; hosts derive it once and never change it for a stored project. */
const projectKeySchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/, {
    message:
      'Project keys are 1 to 64 lowercase letters, digits or dashes and start with a letter or digit.',
  }),
);

/** One project a host can serve. `root` is a display location (a path locally); hosted sources omit it. */
const projectRecordSchema = stripStruct({
  key: projectKeySchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  root: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  projectId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});

type ProjectRecord = typeof projectRecordSchema.Type;

export { projectKeySchema, projectRecordSchema, type ProjectRecord };
