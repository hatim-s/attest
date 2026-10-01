import type { JsonValue } from '@attest/contracts';

/** Narrows extracted foreign data to JSON so it can become part of a native response envelope. */
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
};

export { isJsonValue };
