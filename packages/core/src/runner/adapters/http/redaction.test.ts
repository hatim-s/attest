import { describe, expect, it } from 'vitest';

import { redactEventEvidence } from './redaction.js';

describe('transport event redaction', () => {
  it('redacts only own object and array properties', () => {
    const inherited = Object.create({ token: 'inherited-secret' }) as Record<string, unknown>;
    inherited.own = { token: 'own-secret' };
    const value = { inherited, items: [{ token: 'array-secret' }] };

    const redacted = redactEventEvidence(
      value,
      ['/inherited/token', '/inherited/own/token', '/items/0/token'],
      [],
    );

    expect(redacted).not.toContain('own-secret');
    expect(redacted).not.toContain('array-secret');
    expect(Object.getPrototypeOf(inherited)).toMatchObject({ token: 'inherited-secret' });
  });

  it.each([
    '/__proto__/toString',
    '/constructor/prototype/polluted',
    '/items/0/__proto__/polluted',
    '/items/constructor/prototype/polluted',
  ])('rejects prototype-sensitive pointer %s without mutating prototypes', (pointer) => {
    expect(() => redactEventEvidence({ items: [{}] }, [pointer], [])).toThrowError(
      'prototype-sensitive',
    );
    expect(Object.prototype.toString.call({})).toBe('[object Object]');
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(Object.hasOwn(Array.prototype, 'polluted')).toBe(false);
  });
});
