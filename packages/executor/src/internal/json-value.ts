import { isJsonValue, type JsonValue } from '@attest/contracts';

/** Decodes a transport document into the contracts-owned recursive JSON value. */
const parseJson = (source: string): JsonValue => {
  const value: unknown = JSON.parse(source);

  if (!isJsonValue(value)) throw new TypeError('Transport document is not a JSON value.');

  return value;
};

/** Preserves readonly JSON element types when narrowing an array. */
const isJsonArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value);

export { parseJson, isJsonArray };
