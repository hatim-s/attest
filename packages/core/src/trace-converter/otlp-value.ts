import { z } from 'zod';

type AttributeValue = string | number | boolean;

const DIGITS = /^-?\d+$/;

// OTLP JSON encodes 64-bit integers as strings; unsafe ones stay strings so no digits are lost.
const intValueSchema = z.union([
  z.number().refine(Number.isSafeInteger),
  z
    .string()
    .regex(DIGITS)
    .transform((value) => (Number.isSafeInteger(Number(value)) ? Number(value) : value)),
]);

/** Decodes a scalar OTLP AnyValue; arrays and key-value lists are not part of Attest's attributes. */
const anyValueSchema = z.union([
  z.looseObject({ stringValue: z.string() }).transform((value) => value.stringValue),
  z.looseObject({ boolValue: z.boolean() }).transform((value) => value.boolValue),
  z.looseObject({ doubleValue: z.number().finite() }).transform((value) => value.doubleValue),
  z.looseObject({ intValue: intValueSchema }).transform((value) => value.intValue),
  z.looseObject({ bytesValue: z.string() }).transform((value) => value.bytesValue),
]);

const keyValueSchema = z.looseObject({ key: z.string(), value: anyValueSchema });

/**
 * Flattens an OTLP KeyValue array into scalar attributes. Unsupported or malformed entries are
 * dropped rather than failing the export, because frameworks attach many attributes Attest ignores.
 */
const attributesSchema = z
  .array(z.unknown())
  .catch([])
  .transform((entries) => {
    const attributes: Record<string, AttributeValue> = {};
    for (const entry of entries) {
      const parsed = keyValueSchema.safeParse(entry);
      if (parsed.success) attributes[parsed.data.key] = parsed.data.value;
    }
    return attributes;
  });

export { attributesSchema, type AttributeValue };
