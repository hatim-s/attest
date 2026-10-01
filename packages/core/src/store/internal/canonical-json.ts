import { createHash } from 'node:crypto';

import { StoreError } from '../store-error.js';

const compareKeys = ([left]: [string, unknown], [right]: [string, unknown]): number =>
  left < right ? -1 : 1;

/** Tracks the current path's containers so shared references pass but cycles fail. */
const withinAncestors = <T>(value: object, ancestors: Set<object>, convert: () => T): T => {
  if (ancestors.has(value)) {
    throw new StoreError('INVALID_JSON', 'Cyclic values cannot be represented as JSON.');
  }
  ancestors.add(value);
  try {
    return convert();
  } finally {
    ancestors.delete(value);
  }
};

const toCanonicalValue = (value: unknown, ancestors: Set<object>): unknown => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new StoreError('INVALID_JSON', 'JSON numbers must be finite.');
  }
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new StoreError('INVALID_JSON', 'The value cannot be represented as JSON.');
  }
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    // Array.from visits holes as undefined, which the check above rejects.
    return withinAncestors(value, ancestors, () =>
      Array.from(value, (item: unknown) => toCanonicalValue(item, ancestors)),
    );
  }
  return withinAncestors(value, ancestors, () =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(compareKeys)
        .map(([key, entry]) => [key, toCanonicalValue(entry, ancestors)]),
    ),
  );
};

/**
 * Produces deterministic, whitespace-free JSON for persisted blobs.
 * Undefined object properties are absent because JSON-domain equivalence intentionally treats
 * `{ a: undefined }` and `{}` identically; array holes have no JSON equivalent and are rejected.
 * The canonical tree holds only plain objects and primitives, so `JSON.stringify` cannot throw.
 */
const canonicalStringify = (value: unknown): string =>
  JSON.stringify(toCanonicalValue(value, new Set()));

/** Computes the SHA-256 content identity used by store and cache records. */
const contentHash = (value: unknown): string =>
  createHash('sha256').update(canonicalStringify(value)).digest('hex');

export { canonicalStringify, contentHash };
