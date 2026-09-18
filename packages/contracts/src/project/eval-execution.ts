import { z } from 'zod';

import { durationMillisecondsSchema, relativePathSchema } from './shared.js';

const evalWorkerDirectorySchema = relativePathSchema
  .regex(
    /^(?:[^{}]|\{(?:run_id|worker_index)\})+$/u,
    'must use only {run_id} and {worker_index} template variables',
  )
  .refine(
    (value) => !value.split(/[\\/]/u).every((segment) => segment === '' || segment === '.'),
    'must resolve below the project root',
  );

/** Configures the isolated project-relative directory assigned to each eval worker. */
const evalWorkersSchema = z.strictObject({
  count: z.number().int().positive(),
  directory: evalWorkerDirectorySchema,
});

/** Defines one lifecycle command without invoking a shell parser. */
const evalHookCommandSchema = z.strictObject({
  argv: z.array(z.string().min(1)).nonempty(),
  timeout_ms: durationMillisecondsSchema.optional(),
});

/** Configures commands around the eval run and each selected case. */
const evalHooksSchema = z.strictObject({
  before_run: evalHookCommandSchema.optional(),
  before_case: evalHookCommandSchema.optional(),
  after_case: evalHookCommandSchema.optional(),
  after_run: evalHookCommandSchema.optional(),
});

/** Groups project-authored eval worker and lifecycle-hook defaults. */
const evalExecutionConfigSchema = z.strictObject({
  workers: evalWorkersSchema.optional(),
  hooks: evalHooksSchema.optional(),
});

type EvalExecutionConfig = z.infer<typeof evalExecutionConfigSchema>;
type EvalHookCommand = z.infer<typeof evalHookCommandSchema>;
type EvalHooks = z.infer<typeof evalHooksSchema>;
type EvalWorkers = z.infer<typeof evalWorkersSchema>;

export {
  evalExecutionConfigSchema,
  evalHookCommandSchema,
  evalHooksSchema,
  evalWorkerDirectorySchema,
  evalWorkersSchema,
  type EvalExecutionConfig,
  type EvalHookCommand,
  type EvalHooks,
  type EvalWorkers,
};
