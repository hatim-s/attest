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
