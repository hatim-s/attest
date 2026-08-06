import { describe, expect, it } from 'vitest';

import { canonicalStringify, contentHash } from './canonical-json.js';

describe('canonicalStringify', () => {
  it('treats undefined object properties as absent', () => {
    expect(canonicalStringify({ zeta: undefined, alpha: 1 })).toBe('{"alpha":1}');
  });

  it.each([NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-finite number %s',
    (value) => {
      expect(() => canonicalStringify({ value })).toThrowError(
        expect.objectContaining({ code: 'INVALID_JSON' }),
      );
    },
  );

  it('rejects undefined values and holes inside arrays', () => {
    expect(() => canonicalStringify([undefined])).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
    expect(() => canonicalStringify(new Array(1))).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
  });

  it('rejects cyclic values with a typed error', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalStringify(value)).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
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
