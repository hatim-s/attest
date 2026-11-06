import { ulidSchema, positiveIntegerSchema, nonnegativeIntegerSchema } from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { canonicalJson } from '../internal/canonical-json.js';

const resourceIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, { message: 'must be a lowercase slug' }),
);

const projectIdSchema = ulidSchema;

const sha256Schema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u, { message: 'must be a lowercase SHA-256 digest' }),
);

// Reject drive-qualified/absolute paths and complete `..` segments on either path separator.
const relativePathSchema = Schema.String.check(Schema.isMinLength(1))
  .check(
    Schema.isPattern(/^(?![A-Za-z]:)/u, { message: 'must not use a Windows drive-qualified path' }),
  )
  .check(
    Schema.isPattern(/^(?![\\/])(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).+$/u, {
      message: 'must be a project-relative path without parent traversal',
    }),
  );

const jsonPointerSchema = Schema.String.check(
  Schema.isPattern(/^(?:\/(?:[^~/]|~[01])*)*$/, { message: 'must be an RFC 6901 JSON Pointer' }),
);

const durationMillisecondsSchema = positiveIntegerSchema;

// Segments allow internal spaces but exclude whitespace at either end and dot traversal.
const folderSegment = String.raw`(?!\.{1,2}(?:/|$))[^\s/\\](?:[^/\\]*[^\s/\\])?`;

/** Logical case folder; the pattern is also emitted in the public JSON schemas. */
const caseFolderSchema = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.isPattern(new RegExp(String.raw`^${folderSegment}(?:/${folderSegment})*(?![\s\S])`, 'u'), {
    message: 'Use non-empty slash-separated folder names without dot segments or backslashes.',
  }),
);

/** Any JSON value accepted at a contract boundary. */
const jsonValueSchema = Schema.Json;

/** Correlates one in-flight request with its reply on a shared connection or process. */
const requestIdSchema = Schema.String.check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(128))
  .check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, {
      message:
        'must start with an alphanumeric character and contain only correlation-safe characters',
    }),
  );

/**
 * Bounded evidence of a transport payload, retained per attempt so runs stay auditable without
 * persisting unbounded bodies. On cap overflow the excerpt keeps a prefix, and `sha256` digests
 * everything received.
 */
const rawExcerptSchema = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(4_096)),
  truncated: Schema.Boolean,
  sha256: Schema.optional(sha256Schema),
}).check(
  Schema.makeFilter((excerpt) =>
    !excerpt.truncated || excerpt.sha256 !== undefined
      ? undefined
      : 'a truncated excerpt must carry the sha256 of the full payload',
  ),
);

/** References a host-provided secret without persisting the secret value. */
const secretReferenceSchema = Schema.Union([
  Schema.Struct({ from_env: Schema.String.check(Schema.isMinLength(1)) }),
  Schema.Struct({ from_file: relativePathSchema }),
]);

/** Describes deterministic retry behavior shared by agent and metric transports. */
const retryPolicySchema = Schema.Struct({
  retries: nonnegativeIntegerSchema,
  backoff: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('none') }),
    Schema.Struct({
      kind: Schema.Literal('fixed'),
      delay_ms: durationMillisecondsSchema,
    }),
    Schema.Struct({
      kind: Schema.Literal('exponential'),
      initial_delay_ms: durationMillisecondsSchema,
      maximum_delay_ms: durationMillisecondsSchema,
      jitter_seed: nonnegativeIntegerSchema,
    }),
  ]),
});

/** Names runner defaults that a project or test may override. */
const executionDefaultsSchema = Schema.Struct({
  concurrency: Schema.optional(positiveIntegerSchema),
  timeout_ms: Schema.optional(durationMillisecondsSchema),
  output_cap_bytes: Schema.optional(positiveIntegerSchema),
  retries: Schema.optional(nonnegativeIntegerSchema),
});

type PollingSchedule = {
  status_url_pointer?: string;
  status_url_template?: string;
  success_values: readonly JsonValue[];
  failure_values: readonly JsonValue[];
  minimum_interval_ms: number;
  maximum_interval_ms: number;
};

/**
 * Checks the polling rules shared by authored polling transports and cURL polling imports, so an
 * import cannot produce an agent that later fails validation.
 */
const refinePollingSchedule = (polling: PollingSchedule, context: Schema.FilterIssue[]): void => {
  if ((polling.status_url_pointer === undefined) === (polling.status_url_template === undefined)) {
    context.push({
      path: ['status_url_pointer'],
      issue: 'provide exactly one status URL pointer or template',
    });
  }

  if (polling.minimum_interval_ms > polling.maximum_interval_ms) {
    context.push({
      path: ['maximum_interval_ms'],
      issue: 'must be greater than or equal to minimum_interval_ms',
    });
  }

  const failureValues = new Set(polling.failure_values.map((value) => canonicalJson(value)));

  if (polling.success_values.some((value) => failureValues.has(canonicalJson(value)))) {
    context.push({
      path: ['failure_values'],
      issue: 'must not overlap success_values',
    });
  }
};

/** Narrows unknown input to JSON so callers can drop hand-rolled recursive guards. */
const isJsonValue = (value: unknown): value is JsonValue => Schema.is(jsonValueSchema)(value);

type ExecutionDefaults = typeof executionDefaultsSchema.Type;

type JsonValue = typeof jsonValueSchema.Type;

type RawExcerpt = typeof rawExcerptSchema.Type;

type SecretReference = typeof secretReferenceSchema.Type;

/** Identifies scalar strings in decoded JSON and authored template values. */
const isString = (value: unknown): value is string => typeof value === 'string';

/** Identifies scalar numbers before domain-specific numeric checks. */
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** Identifies boolean schema branches. */
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/** Identifies object containers in decoded JSON without claiming any field schema. */
const isJsonObject = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export {
  caseFolderSchema,
  durationMillisecondsSchema,
  executionDefaultsSchema,
  isJsonValue,
  isString,
  isNumber,
  isBoolean,
  isJsonObject,
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
