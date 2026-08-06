import { createHash } from 'node:crypto';

import { StoreError } from '../types.js';

const sortObjectKeys = (value: unknown, ancestors: Set<object>): unknown => {
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

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new StoreError('INVALID_JSON', 'Cyclic values cannot be represented as JSON.');
    }

    ancestors.add(value);
    try {
      return Array.from({ length: value.length }, (_, index) =>
        sortObjectKeys(value[index], ancestors),
      );
    } finally {
      ancestors.delete(value);
    }
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (ancestors.has(value)) {
    throw new StoreError('INVALID_JSON', 'Cyclic values cannot be represented as JSON.');
  }

  ancestors.add(value);
  try {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => Reflect.get(value, key) !== undefined)
        .map((key) => [key, sortObjectKeys(Reflect.get(value, key), ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
};

/**
 * Produces deterministic, whitespace-free JSON for persisted blobs (PLAN 1S.3).
 * Undefined object properties are absent because JSON-domain equivalence intentionally treats
 * `{ a: undefined }` and `{}` identically; array holes have no JSON equivalent and are rejected.
 */
const canonicalStringify = (value: unknown): string => {
  try {
    return JSON.stringify(sortObjectKeys(value, new Set()));
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }

    throw new StoreError('INVALID_JSON', 'The value cannot be represented as JSON.', {
      cause: error,
    });
  }
};

/**
 * Computes the SHA-256 content identity used by store and cache records (PLAN 1S.3).
 */
const contentHash = (value: unknown): string =>
  createHash('sha256').update(canonicalStringify(value)).digest('hex');

export { canonicalStringify, contentHash };
