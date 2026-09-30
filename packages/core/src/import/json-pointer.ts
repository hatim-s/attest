import type { JsonValue } from '@attest/contracts';

type PointerResolution = { found: true; value: JsonValue } | { found: false };

/** Escapes one RFC 6901 reference token. */
const escapePointerSegment = (segment: PropertyKey): string =>
  String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

/** Joins path segments into an RFC 6901 pointer; the empty path is the whole document. */
const toPointer = (segments: readonly PropertyKey[]): string =>
  segments.map((segment) => `/${escapePointerSegment(segment)}`).join('');

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

const childValue = (current: JsonValue, segment: string): PointerResolution => {
  if (Array.isArray(current)) {
    if (!ARRAY_INDEX.test(segment)) return { found: false };
    const index = Number(segment);
    if (index >= current.length) return { found: false };
    return { found: true, value: current[index]! };
  }
  if (current === null || typeof current !== 'object') return { found: false };
  if (!Object.hasOwn(current, segment)) return { found: false };
  return { found: true, value: current[segment]! };
};

/** Resolves an RFC 6901 pointer without interpreting dotted object keys. */
const resolveJsonPointer = (value: JsonValue, pointer: string): PointerResolution => {
  if (pointer === '') return { found: true, value };
  if (!pointer.startsWith('/')) return { found: false };
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const child = childValue(current, encoded.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (!child.found) return child;
    current = child.value;
  }
  return { found: true, value: current };
};

export { escapePointerSegment, resolveJsonPointer, toPointer };
