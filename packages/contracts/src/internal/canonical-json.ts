import { z } from 'zod';
import type { JsonValue } from '../project/shared.js';

const isJsonObject = (value: JsonValue): value is Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Emits JSON keys in code-unit order after JSON.stringify has applied its normal omission rules. */
const sortObjectKeys = (_key: string, value: JsonValue): JsonValue =>
  isJsonObject(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)))
    : value;

/** Serializes JSON so insertion order does not affect equality or output. */
// BOUNDARY: Contract and schema values are encoded as JSON, then validated before canonical ordering.
const canonicalJson = (value: unknown, indentation?: number): string => {
  const json = z.json().parse(JSON.parse(JSON.stringify(value)));

  return JSON.stringify(json, sortObjectKeys, indentation);
};

export { canonicalJson };
