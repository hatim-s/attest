import { describe, expect, it } from 'vitest';

import { isUnparseableResponse } from './structured-output.js';

describe('isUnparseableResponse', () => {
  it.each([
    new Error('Structured output did not match the schema.'),
    new Error('Provider did not return valid JSON.'),
    'Could not parse response JSON.',
  ])('recognizes message fallback %s', (error) => {
    expect(isUnparseableResponse(error)).toBe(true);
  });

  it.each([new Error('Provider unavailable.'), 'socket closed', { message: 'valid json' }])(
    'rejects unrelated fallback %s',
    (error) => {
      expect(isUnparseableResponse(error)).toBe(false);
    },
  );
});
