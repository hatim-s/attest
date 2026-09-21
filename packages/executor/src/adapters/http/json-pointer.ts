/** Decodes one RFC 6901 reference token after the pointer grammar has been validated. */
const decodePointerToken = (token: string): string =>
  token.replaceAll('~1', '/').replaceAll('~0', '~');

/** Reads an RFC 6901 JSON Pointer without falling back to property-path heuristics. */
const readJsonPointer = (document: unknown, pointer: string): unknown => {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;

  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = decodePointerToken(encoded);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      current = current[Number(token)];
      continue;
    }
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
};

export { readJsonPointer };
