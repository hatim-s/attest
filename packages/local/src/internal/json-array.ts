import type { JsonValue } from '@attest/contracts';

/** Narrows decoded JSON arrays without losing readonly element types to Array.isArray. */
const isJsonArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value);

export { isJsonArray };
