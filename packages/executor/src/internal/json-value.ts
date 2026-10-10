import { isJsonValue, type JsonValue } from '@attest/contracts';

/** Decodes a transport JSON document into the contracts-owned recursive JSON value. */
const parseJson = (source: string): JsonValue => {
  const value: unknown = JSON.parse(source);

  if (!isJsonValue(value)) throw new TypeError('Transport document is not a JSON value.');

  return value;
};

const isString = (value: unknown): value is string => typeof value === 'string';

const isNumber = (value: unknown): value is number => typeof value === 'number';

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isJsonObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export { isBoolean, isJsonObject, isJsonValue, isNumber, isString, parseJson };
