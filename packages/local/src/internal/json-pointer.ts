import { isJsonValue, type JsonValue } from '@attest/contracts';

/** Escapes one RFC 6901 reference token so `/` and `~` inside keys stay unambiguous. */
const escapeJsonPointerSegment = (segment: PropertyKey): string =>
  String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

/** Builds an RFC 6901 pointer from a zod issue path or any key list; the root is `''`. */
const toJsonPointer = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '' : `/${path.map(escapeJsonPointerSegment).join('/')}`;

/** Splits and unescapes an RFC 6901 pointer; returns undefined for a malformed pointer. */
const parseJsonPointer = (pointer: string): string[] | undefined => {
  if (pointer === '') return [];

  if (!pointer.startsWith('/')) return undefined;
  const segments: string[] = [];

  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(encoded)) return undefined;
    segments.push(encoded.replaceAll('~1', '/').replaceAll('~0', '~'));
  }

  return segments;
};

// BOUNDARY: A pointer walks untrusted JSON containers; only own fields are read, and the selected leaf is validated as JSON.
const isPointerObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Reads one RFC 6901 pointer from untrusted JSON. Only own properties are followed, so a
 * pointer such as `/__proto__` or `/constructor` never reaches inherited values.
 */
// BOUNDARY: Caller-supplied HTTP JSON is traversed using validated pointer segments; invalid/non-JSON leaves return undefined.
const readJsonPointer = (value: unknown, pointer: string): JsonValue | undefined => {
  const segments = parseJsonPointer(pointer);

  if (segments === undefined) return undefined;
  let current = value;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!isPointerObject(current) || !Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    }
  }

  return isJsonValue(current) ? current : undefined;
};

export { escapeJsonPointerSegment, parseJsonPointer, readJsonPointer, toJsonPointer };
