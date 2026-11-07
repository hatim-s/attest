import * as SchemaGetter from 'effect/SchemaGetter';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { looseStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';

import { attributesSchema } from './otlp-value.js';

/** Normalizes validated hexadecimal identifiers without changing their width. */
const hexIdSchema = (length: number) =>
  Schema.String.check(
    Schema.isPattern(new RegExp(`^[a-fA-F0-9]{${length}}$`), {
      message: `must be a ${length}-character hex string`,
    }),
  ).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value) => value.toLowerCase()),
      encode: SchemaGetter.passthrough(),
    }),
  );

/** Converts validated nanoseconds to RFC 3339 millisecond precision. */
const timestampSchema = Schema.Union([Schema.String, Schema.Finite])
  .check(
    Schema.makeFilter((value) => {
      // All-errors decoding evaluates sibling checks, so guard BigInt in this same filter.
      if (!/^\d+$/.test(String(value))) return 'must be an unsigned nanosecond timestamp';

      if (Number.isNaN(new Date(Number(BigInt(value) / 1_000_000n)).getTime()))
        return 'is outside the Date range';

      return true;
    }),
  )
  .pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value) =>
        new Date(Number(BigInt(value) / 1_000_000n)).toISOString(),
      ),
      encode: SchemaGetter.transform((value) => String(BigInt(Date.parse(value)) * 1_000_000n)),
    }),
  );

const parentSpanIdSchema = Schema.Union([Schema.Literal(''), hexIdSchema(16)]).pipe(
  Schema.decodeTo(Schema.NullOr(Schema.String), {
    decode: SchemaGetter.transform((value) => (value === '' ? null : value)),
    encode: SchemaGetter.transform((value) => value ?? ''),
  }),
  Schema.withDecodingDefault(Effect.succeed('')),
);

const statusSchema = Schema.optional(
  looseStruct({
    code: Schema.Unknown,
    message: Schema.optional(Schema.String).pipe(
      Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
    ),
  }),
).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))));

const eventSchema = looseStruct({
  name: Schema.String.check(Schema.isMinLength(1)),
  timeUnixNano: timestampSchema,
  attributes: attributesSchema,
});

const otlpSpanSchema = looseStruct({
  traceId: hexIdSchema(32),
  spanId: hexIdSchema(16),
  parentSpanId: parentSpanIdSchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  startTimeUnixNano: timestampSchema,
  endTimeUnixNano: timestampSchema,
  attributes: attributesSchema,
  events: Schema.optional(Schema.Array(eventSchema)),
  status: statusSchema,
});

const scopeSchema = Schema.optional(
  looseStruct({
    name: Schema.optional(Schema.String).pipe(
      Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
    ),
    version: Schema.optional(Schema.String).pipe(
      Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
    ),
  }),
).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))));

/**
 * Accepts the subset of an OTLP/HTTP JSON trace export that Attest converts. Objects stay loose
 * because exporters add vendor fields; attribute and scope metadata degrade instead of failing.
 */
const otlpExportSchema = looseStruct({
  resourceSpans: Schema.Array(
    looseStruct({
      resource: looseStruct({ attributes: attributesSchema }).pipe(
        Schema.catchDecoding(() => Effect.succeed(Option.some({ attributes: {} }))),
        Schema.withDecodingDefault(Effect.succeed({ attributes: [] })),
      ),
      scopeSpans: Schema.Array(
        looseStruct({ scope: scopeSchema, spans: Schema.Array(otlpSpanSchema) }),
      ),
    }),
  ),
});

type OtlpExport = typeof otlpExportSchema.Type;

type OtlpResourceSpans = OtlpExport['resourceSpans'][number];

type OtlpScopeSpans = OtlpResourceSpans['scopeSpans'][number];

type OtlpSpan = typeof otlpSpanSchema.Type;

export { otlpExportSchema, type OtlpScopeSpans, type OtlpSpan };
