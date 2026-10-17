import { isJsonObject, type JsonValue } from '@attest/contracts';

/** Decodes one RFC 6901 reference token after the pointer grammar has been validated. */
const decodePointerToken = (token: string): string =>
  token.replaceAll('~1', '/').replaceAll('~0', '~');

/** Splits a schema-validated RFC 6901 pointer into decoded tokens; the root pointer has none. */
const splitJsonPointer = (pointer: string): string[] =>
  pointer === '' ? [] : pointer.slice(1).split('/').map(decodePointerToken);

/**
 * Reads an RFC 6901 JSON Pointer without falling back to property-path heuristics. An absent
 * pointer reads nothing, so optional authored extractions need no guard at each call site.
 */
const readJsonPointer = (
  document: JsonValue,
  pointer: string | undefined,
): JsonValue | undefined => {
  if (pointer === undefined) return undefined;

  if (pointer !== '' && !pointer.startsWith('/')) return undefined;

  let current: JsonValue | undefined = document;

  for (const token of splitJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      current = current[Number(token)];
      continue;
    }

    if (!isJsonObject(current) || !Object.hasOwn(current, token)) return undefined;

    current = current[token];
  }

  return current;
};

export { readJsonPointer, splitJsonPointer };
