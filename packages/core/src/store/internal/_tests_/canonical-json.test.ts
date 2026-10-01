import { describe, expect, it } from 'vitest';

import { StoreError } from '../../store-error.js';
import { canonicalStringify, contentHash } from '../canonical-json.js';

const cyclicValue = (): Record<string, unknown> => {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
};

describe('canonicalStringify', () => {
  it('treats undefined object properties as absent', () => {
    expect(canonicalStringify({ zeta: undefined, alpha: 1 })).toBe('{"alpha":1}');
  });

  it.each([
    ['NaN', { value: NaN }],
    ['positive infinity', { value: Number.POSITIVE_INFINITY }],
    ['negative infinity', { value: Number.NEGATIVE_INFINITY }],
    ['undefined inside an array', [undefined]],
    ['an array hole', new Array(1)],
    ['a cycle', cyclicValue()],
  ])('rejects %s with a typed error', (_, value) => {
    expect(() => canonicalStringify(value)).toThrowError(StoreError);
  });

  it('sorts object keys recursively without reordering arrays', () => {
    expect(canonicalStringify({ zeta: { delta: 4, alpha: 1 }, alpha: [{ z: 2, a: 1 }] })).toBe(
      '{"alpha":[{"a":1,"z":2}],"zeta":{"alpha":1,"delta":4}}',
    );
  });

  it('produces identical hashes for recursively equivalent key orderings', () => {
    expect(contentHash({ zeta: { beta: 2, alpha: 1 }, alpha: true })).toBe(
      contentHash({ alpha: true, zeta: { alpha: 1, beta: 2 } }),
    );
    expect(contentHash({ alpha: 1 })).not.toBe(contentHash({ alpha: 2 }));
  });
});
