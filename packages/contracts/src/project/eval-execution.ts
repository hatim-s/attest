import { positiveIntegerSchema } from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { durationMillisecondsSchema, relativePathSchema } from './shared.js';

const evalWorkerDirectorySchema = relativePathSchema
  .check(
    Schema.isPattern(/^(?:[^{}]|\{(?:run_id|worker_index)\})+$/u, {
      message: 'must use only {run_id} and {worker_index} template variables',
    }),
  )
  .check(
    Schema.makeFilter((value) =>
      !value.split(/[\\/]/u).every((segment) => segment === '' || segment === '.')
        ? undefined
        : 'must resolve below the project root',
    ),
  );

/** Configures the isolated project-relative directory assigned to each eval worker. */
const evalWorkersSchema = Schema.Struct({
  count: positiveIntegerSchema,
  directory: evalWorkerDirectorySchema,
});

/** Defines one lifecycle command without invoking a shell parser. */
const evalHookCommandSchema = Schema.Struct({
  argv: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  timeout_ms: Schema.optional(durationMillisecondsSchema),
});

/** Configures commands around the eval run and each selected case. */
const evalHooksSchema = Schema.Struct({
  before_run: Schema.optional(evalHookCommandSchema),
  before_case: Schema.optional(evalHookCommandSchema),
  after_agent: Schema.optional(evalHookCommandSchema),
  after_evaluation: Schema.optional(evalHookCommandSchema),
  after_case: Schema.optional(evalHookCommandSchema),
  after_run: Schema.optional(evalHookCommandSchema),
});

/** Runs command metrics inside a sandbox instead of on the host. */
const metricSandboxSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('vercel'),
    image: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
]);

/** Groups project-authored eval worker, lifecycle-hook and metric sandbox defaults. */
const evalExecutionConfigSchema = Schema.Struct({
  workers: Schema.optional(evalWorkersSchema),
  hooks: Schema.optional(evalHooksSchema),
  metric_sandbox: Schema.optional(metricSandboxSchema),
});

type EvalExecutionConfig = typeof evalExecutionConfigSchema.Type;

type EvalHookCommand = typeof evalHookCommandSchema.Type;

type EvalHooks = typeof evalHooksSchema.Type;

type EvalWorkers = typeof evalWorkersSchema.Type;

type MetricSandbox = typeof metricSandboxSchema.Type;

export {
  evalExecutionConfigSchema,
  evalHookCommandSchema,
  evalHooksSchema,
  evalWorkerDirectorySchema,
  evalWorkersSchema,
  metricSandboxSchema,
  type EvalExecutionConfig,
  type EvalHookCommand,
  type EvalHooks,
  type EvalWorkers,
  type MetricSandbox,
};
