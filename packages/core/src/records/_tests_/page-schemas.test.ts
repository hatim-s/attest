import { parseWithSchemaSync } from '@attest/contracts';
import { indexedTimestampSchema } from '../dashboard-schemas.js';
import { expect, it } from 'vitest';

import { StoreError } from '../../store/store-error.js';
import { parsePageLimit } from '../page-schemas.js';

it('defaults omitted limits and rejects invalid bounds with the store error contract', () => {
  expect(parsePageLimit()).toBe(100);
  expect(parsePageLimit({ cursor: 'opaque' })).toBe(100);
  expect(parsePageLimit({ limit: 1 })).toBe(1);
  expect(parsePageLimit({ limit: 1_000 })).toBe(1_000);

  for (const limit of [0, -1, 1.5, 1_001]) {
    expect(() => parsePageLimit({ limit })).toThrowError(
      new StoreError('INVALID_LIMIT', 'Page limit must be an integer from 1 to 1000.'),
    );
  }
});

it('accepts main ISO timestamp precision and rejects invalid dates, times and offsets', () => {
  for (const value of [
    '2026-01-01T00:00Z',
    '2026-01-01T05:30+05:30',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.123456+05:30',
    '2024-02-29T23:59:59.1-23:59',
  ]) {
    expect(parseWithSchemaSync(indexedTimestampSchema, value)).toBe(value);
  }

  for (const value of [
    '2026-02-29T00:00Z',
    '2026-01-01T24:00Z',
    '2026-01-01T00:60Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00.123Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+05:60',
    '2026-01-01T00:00+0530',
    '2026-01-01T00:00',
    '2026-01-01',
  ]) {
    expect(() => parseWithSchemaSync(indexedTimestampSchema, value), value).toThrow();
  }
});
