import { describe, expect, it } from 'vitest';

import { canonicalStringify } from './canonical-json.js';

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
});
