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

/**
 * Reads one RFC 6901 pointer from untrusted JSON. Only own properties are followed, so a
 * pointer such as `/__proto__` or `/constructor` never reaches inherited values.
 */
const readJsonPointer = (value: unknown, pointer: string): unknown => {
  const segments = parseJsonPointer(pointer);
  if (segments === undefined) return undefined;
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = Reflect.get(current, segment);
    }
  }
  return current;
};

export { escapeJsonPointerSegment, parseJsonPointer, readJsonPointer, toJsonPointer };
