import { parseWithSchemaSync } from '@attest/contracts';
import { StoreError } from '../store/store-error.js';
import { indexedTimestampSchema } from './dashboard-schemas.js';

/** Longest activity interval any host serves, so one request stays bounded. */
const MAX_ACTIVITY_DAYS = 92;

/**
 * Normalises an ISO timestamp to the UTC form indexes sort by.
 * Callers pick the error code: a bad stored value is corrupt data, a bad query is an invalid limit.
 */
const canonicalTime = (
  value: string,
  code: 'INVALID_RECORD' | 'CORRUPT_DATA' | 'INVALID_LIMIT',
): string => {
  try {
    parseWithSchemaSync(indexedTimestampSchema, value);
  } catch (cause) {
    throw new StoreError(code, `Invalid timestamp: ${value}`, { cause });
  }

  return new Date(Date.parse(value)).toISOString();
};

/** Validates an activity query once for every host: ordered and at most MAX_ACTIVITY_DAYS long. */
const activityBounds = (query: { from: string; to: string }) => {
  const from = canonicalTime(query.from, 'INVALID_LIMIT');
  const to = canonicalTime(query.to, 'INVALID_LIMIT');

  if (to <= from || Date.parse(to) - Date.parse(from) > MAX_ACTIVITY_DAYS * 86_400_000)
    throw new StoreError(
      'INVALID_LIMIT',
      `Activity requires an interval of at most ${MAX_ACTIVITY_DAYS} days.`,
    );

  return { from, to };
};

export { MAX_ACTIVITY_DAYS, canonicalTime, activityBounds };
