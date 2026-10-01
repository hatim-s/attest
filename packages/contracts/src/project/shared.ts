import { z } from 'zod';

import { canonicalJson } from '../internal/canonical-json.js';

const resourceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'must be a lowercase slug');
const projectIdSchema = z.ulid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest');
// Reject drive-qualified/absolute paths and complete `..` segments on either path separator.
const relativePathSchema = z
  .string()
  .min(1)
  .regex(/^(?![A-Za-z]:)/u, 'must not use a Windows drive-qualified path')
  .regex(
    /^(?![\\/])(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).+$/u,
    'must be a project-relative path without parent traversal',
  );
const jsonPointerSchema = z
  .string()
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/, 'must be an RFC 6901 JSON Pointer');
const durationMillisecondsSchema = z.number().int().positive();

// Segments allow internal spaces but exclude whitespace at either end and dot traversal.
const folderSegment = String.raw`(?!\.{1,2}(?:/|$))[^\s/\\](?:[^/\\]*[^\s/\\])?`;

/** Logical case folder; the pattern is also emitted in the public JSON schemas. */
const caseFolderSchema = z
  .string()
  .min(1)
  .regex(
    new RegExp(String.raw`^${folderSegment}(?:/${folderSegment})*(?![\s\S])`, 'u'),
    'Use non-empty slash-separated folder names without dot segments or backslashes.',
  );

/** Any JSON value accepted at a contract boundary. */
const jsonValueSchema = z.json();

/** Correlates one in-flight request with its reply on a shared connection or process. */
const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    'must start with an alphanumeric character and contain only correlation-safe characters',
  );

/**
 * Bounded evidence of a transport payload, retained per attempt so runs stay auditable without
 * persisting unbounded bodies. On cap overflow the excerpt keeps a prefix, and `sha256` digests
 * everything received.
 */
const rawExcerptSchema = z
  .strictObject({
    text: z.string().max(4_096),
    truncated: z.boolean(),
    sha256: sha256Schema.optional(),
  })
  .refine(
    (excerpt) => !excerpt.truncated || excerpt.sha256 !== undefined,
    'a truncated excerpt must carry the sha256 of the full payload',
  );

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

type PollingSchedule = {
  status_url_pointer?: string;
  status_url_template?: string;
  success_values: readonly unknown[];
  failure_values: readonly unknown[];
  minimum_interval_ms: number;
  maximum_interval_ms: number;
};

/**
 * Checks the polling rules shared by authored polling transports and cURL polling imports, so an
 * import cannot produce an agent that later fails validation.
 */
const refinePollingSchedule = (polling: PollingSchedule, context: z.RefinementCtx): void => {
  if ((polling.status_url_pointer === undefined) === (polling.status_url_template === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['status_url_pointer'],
      message: 'provide exactly one status URL pointer or template',
    });
  }
  if (polling.minimum_interval_ms > polling.maximum_interval_ms) {
    context.addIssue({
      code: 'custom',
      path: ['maximum_interval_ms'],
      message: 'must be greater than or equal to minimum_interval_ms',
    });
  }
  const failureValues = new Set(polling.failure_values.map((value) => canonicalJson(value)));
  if (polling.success_values.some((value) => failureValues.has(canonicalJson(value)))) {
    context.addIssue({
      code: 'custom',
      path: ['failure_values'],
      message: 'must not overlap success_values',
    });
  }
};

/** Narrows unknown input to JSON so callers can drop hand-rolled recursive guards. */
const isJsonValue = (value: unknown): value is JsonValue =>
  jsonValueSchema.safeParse(value).success;

type ExecutionDefaults = z.infer<typeof executionDefaultsSchema>;
type JsonValue = z.infer<typeof jsonValueSchema>;
type RawExcerpt = z.infer<typeof rawExcerptSchema>;
type SecretReference = z.infer<typeof secretReferenceSchema>;

export {
  caseFolderSchema,
  durationMillisecondsSchema,
  executionDefaultsSchema,
  isJsonValue,
  jsonPointerSchema,
  jsonValueSchema,
  projectIdSchema,
  rawExcerptSchema,
  refinePollingSchedule,
  relativePathSchema,
  requestIdSchema,
  resourceIdSchema,
  retryPolicySchema,
  secretReferenceSchema,
  sha256Schema,
  type ExecutionDefaults,
  type JsonValue,
  type RawExcerpt,
  type SecretReference,
};
