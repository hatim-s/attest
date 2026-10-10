import { AgentInvocationError } from '../../errors.js';
import { isJsonValue, type JsonValue } from '@attest/contracts';

/** BOUNDARY: inspects a transport document's own fields before pointer traversal. */
const isContainer = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/** Decodes one RFC 6901 reference token after the pointer grammar has been validated. */
const decodePointerToken = (token: string): string =>
  token.replaceAll('~1', '/').replaceAll('~0', '~');

/** Splits a schema-validated RFC 6901 pointer into decoded tokens; the root pointer has none. */
const splitJsonPointer = (pointer: string): string[] =>
  pointer === '' ? [] : pointer.slice(1).split('/').map(decodePointerToken);

/**
 * BOUNDARY: traverses foreign transport JSON and returns only a contracts-valid JSON leaf.
 * Reads an RFC 6901 JSON Pointer without falling back to property-path heuristics. An absent
 * pointer reads nothing, so optional authored extractions need no guard at each call site.
 */
const readJsonPointer = (document: unknown, pointer: string | undefined): JsonValue | undefined => {
  if (pointer === undefined) return undefined;

  if (pointer !== '' && !pointer.startsWith('/')) return undefined;

  let current = document;

  for (const token of splitJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      current = current[Number(token)];
      continue;
    }

    if (!isContainer(current) || !Object.hasOwn(current, token)) {
      return undefined;
    }

    current = current[token];
  }

  if (current === undefined || isJsonValue(current)) return current;
  throw new AgentInvocationError('invalid_envelope', 'Extracted transport value is not JSON.');
};

export { readJsonPointer, splitJsonPointer };
