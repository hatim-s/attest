import type { z } from 'zod';
import type { JsonValue } from '../project/shared.js';

const isJsonObject = (value: JsonValue): value is Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Emits JSON keys in code-unit order after JSON.stringify has applied its normal omission rules. */
const sortObjectKeys = (_key: string, value: JsonValue): JsonValue =>
  isJsonObject(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)))
    : value;

/** Serializes JSON so insertion order does not affect equality or output. */
const canonicalJson = (
  value: JsonValue | z.core.JSONSchema.BaseSchema,
  indentation?: number,
): string => JSON.stringify(value, sortObjectKeys, indentation);

export { canonicalJson };
