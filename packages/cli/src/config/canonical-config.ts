import { createHash } from 'node:crypto';

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Sorts object keys recursively so formatting-only config changes retain one identity. */
const canonicalizeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      // Code-unit ordering is locale-independent, so config hashes match across CI hosts.
      .sort(([left], [right]) => (left > right ? 1 : 0) - (left < right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
};

/** Produces the canonical config document persisted with every run. */
const serializeCanonicalConfig = (value: JsonValue): string =>
  JSON.stringify(canonicalizeJson(value));

/** Hashes canonical config JSON with an explicit algorithm prefix for future migrations. */
const hashCanonicalConfig = (canonicalJson: string): string =>
  `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`;

export { hashCanonicalConfig, serializeCanonicalConfig, type JsonValue };
