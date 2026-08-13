import { describe, expect, it } from 'vitest';

import { redactEventEvidence } from '../redaction.js';

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

  it('redacts schema-valid prototype-named own JSON properties', () => {
    const value = JSON.parse(
      '{"constructor":"constructor-secret","prototype":"prototype-secret","__proto__":"proto-secret","nested":{"constructor":{"prototype":{"__proto__":"deep-secret"}}}}',
    ) as Record<string, unknown>;

    const redacted = JSON.parse(
      redactEventEvidence(
        value,
        ['/constructor', '/prototype', '/__proto__', '/nested/constructor/prototype/__proto__'],
        [],
      ),
    ) as Record<string, unknown>;

    expect(Object.hasOwn(redacted, 'constructor')).toBe(true);
    expect(redacted['constructor']).toBe('[REDACTED]');
    expect(Object.hasOwn(redacted, 'prototype')).toBe(true);
    expect(redacted['prototype']).toBe('[REDACTED]');
    expect(Object.hasOwn(redacted, '__proto__')).toBe(true);
    expect(redacted['__proto__']).toBe('[REDACTED]');
    const nested = redacted['nested'] as Record<string, unknown>;
    const constructor = nested['constructor'] as Record<string, unknown>;
    const prototype = constructor['prototype'] as Record<string, unknown>;
    expect(Object.hasOwn(prototype, '__proto__')).toBe(true);
    expect(prototype['__proto__']).toBe('[REDACTED]');
  });

  it.each([
    '/__proto__/toString',
    '/constructor/prototype/polluted',
    '/items/0/__proto__/polluted',
    '/items/constructor/prototype/polluted',
  ])('ignores inherited pointer %s without mutating prototypes', (pointer) => {
    expect(redactEventEvidence({ items: [{}] }, [pointer], [])).toBe('{"items":[{}]}');
    expect(Object.prototype.toString.call({})).toBe('[object Object]');
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(Object.hasOwn(Array.prototype, 'polluted')).toBe(false);
  });
});
