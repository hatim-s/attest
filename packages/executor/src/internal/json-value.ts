import { isJsonValue, type JsonValue } from '@attest/contracts';

/** Decodes a transport document into the contracts-owned recursive JSON value. */
const parseJson = (source: string): JsonValue => {
  const value: unknown = JSON.parse(source);

  if (!isJsonValue(value)) throw new TypeError('Transport document is not a JSON value.');

  return value;
};

export { parseJson };
