import { z } from 'zod';

const resourceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'must be a lowercase slug');
const projectIdSchema = z.ulid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest');
// Reject absolute paths and any complete `..` segment on POSIX or Windows separators.
const relativePathSchema = z
  .string()
  .min(1)
  .regex(
    /^(?![\\/])(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).+$/u,
    'must be a project-relative path without parent traversal',
  );
const jsonPointerSchema = z
  .string()
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/, 'must be an RFC 6901 JSON Pointer');
const durationMillisecondsSchema = z.number().int().positive();

/** References a host-provided secret without persisting the secret value. */
const secretReferenceSchema = z.union([
  z.strictObject({ from_env: z.string().min(1) }),
  z.strictObject({ from_file: relativePathSchema }),
]);

/** Describes deterministic retry behavior shared by agent and metric transports. */
const retryPolicySchema = z.strictObject({
  retries: z.number().int().nonnegative(),
  backoff: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('fixed'),
      delay_ms: durationMillisecondsSchema,
    }),
    z.strictObject({
      kind: z.literal('exponential'),
      initial_delay_ms: durationMillisecondsSchema,
      maximum_delay_ms: durationMillisecondsSchema,
      jitter_seed: z.number().int().nonnegative(),
    }),
  ]),
});

/** Names runner defaults that a project or test may override. */
const executionDefaultsSchema = z.strictObject({
  concurrency: z.number().int().positive().optional(),
  timeout_ms: durationMillisecondsSchema.optional(),
  output_cap_bytes: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
});

type ExecutionDefaults = z.infer<typeof executionDefaultsSchema>;
type SecretReference = z.infer<typeof secretReferenceSchema>;

export {
  durationMillisecondsSchema,
  executionDefaultsSchema,
  jsonPointerSchema,
  projectIdSchema,
  relativePathSchema,
  resourceIdSchema,
  retryPolicySchema,
  secretReferenceSchema,
  sha256Schema,
  type ExecutionDefaults,
  type SecretReference,
};
