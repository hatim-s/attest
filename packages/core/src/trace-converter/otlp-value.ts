import { looseStruct, parseWithSchema } from '@attest/contracts';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';

const scalarSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);

type AttributeValue = typeof scalarSchema.Type;

// Unsafe OTLP integers stay strings so no digits are lost.
const intValueSchema = Schema.Union([
  Schema.Finite.check(Schema.makeFilter(Number.isSafeInteger)),
  Schema.String.check(Schema.isPattern(/^-?\d+$/)).pipe(
    Schema.decodeTo(Schema.Union([Schema.String, Schema.Finite]), {
      decode: SchemaGetter.transform((value) =>
        Number.isSafeInteger(Number(value)) ? Number(value) : value,
      ),
      encode: SchemaGetter.transform(String),
    }),
  ),
]);

/** Decodes only the scalar AnyValue variants Attest supports. */
const anyValueSchema = Schema.Union([
  looseStruct({ stringValue: Schema.String }).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((v) => v.stringValue),
      encode: SchemaGetter.transform((v) => ({ stringValue: v })),
    }),
  ),
  looseStruct({ boolValue: Schema.Boolean }).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((v) => v.boolValue),
      encode: SchemaGetter.transform((v) => ({ boolValue: v })),
    }),
  ),
  looseStruct({ doubleValue: Schema.Finite }).pipe(
    Schema.decodeTo(Schema.Finite, {
      decode: SchemaGetter.transform((v) => v.doubleValue),
      encode: SchemaGetter.transform((v) => ({ doubleValue: v })),
    }),
  ),
  looseStruct({ intValue: intValueSchema }).pipe(
    Schema.decodeTo(Schema.Union([Schema.String, Schema.Finite]), {
      decode: SchemaGetter.transform((v) => v.intValue),
      encode: SchemaGetter.transform((v) => ({ intValue: v })),
    }),
  ),
  looseStruct({ bytesValue: Schema.String }).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((v) => v.bytesValue),
      encode: SchemaGetter.transform((v) => ({ bytesValue: v })),
    }),
  ),
]);

const keyValueSchema = looseStruct({ key: Schema.String, value: anyValueSchema });

/** Drops malformed and unsupported attributes without failing a valid trace. */
const attributesSchema = Schema.Array(Schema.Unknown).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some([]))),
  Schema.decodeTo(Schema.Record(Schema.String, scalarSchema), {
    decode: SchemaGetter.transform((entries) => {
      const attributes: Record<string, AttributeValue> = {};

      for (const entry of entries) {
        const parsed = parseWithSchema(keyValueSchema, entry);

        if (parsed.ok) attributes[parsed.value.key] = parsed.value.value;
      }

      return attributes;
    }),
    encode: SchemaGetter.transform((attributes) =>
      Object.entries(attributes).map(([key, value]) => ({ key, value })),
    ),
  }),
  Schema.withDecodingDefault(Effect.succeed([])),
  Schema.catchDecoding(() => Effect.succeed(Option.some({}))),
);

export { attributesSchema, type AttributeValue };
