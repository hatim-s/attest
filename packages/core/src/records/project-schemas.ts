import { z } from 'zod';

/** URL-safe project identifier; hosts derive it once and never change it for a stored project. */
const projectKeySchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    'Project keys are 1 to 64 lowercase letters, digits or dashes and start with a letter or digit.',
  );

/** One project a host can serve. `root` is a display location (a path locally); hosted sources omit it. */
const projectRecordSchema = z.object({
  key: projectKeySchema,
  name: z.string().min(1),
  root: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

type ProjectKey = z.infer<typeof projectKeySchema>;

type ProjectRecord = z.infer<typeof projectRecordSchema>;

export { projectKeySchema, projectRecordSchema, type ProjectKey, type ProjectRecord };
