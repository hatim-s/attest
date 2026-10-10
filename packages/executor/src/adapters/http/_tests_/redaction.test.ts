import { isJsonObject, parseJson } from '../../../internal/json-value.js';
import { describe, expect, it } from 'vitest';

import { redactEventEvidence, redactTransportText } from '../redaction.js';

describe('transport event redaction', () => {
  it('redacts lowercase percent escapes without changing literal credential casing', () => {
    expect(redactTransportText('token=Secret%2fValue', ['Secret/Value'])).toBe('token=[REDACTED]');
  });

  it('redacts overlapping credentials completely regardless of configuration order', () => {
    expect(
      redactTransportText('token=prefix-sensitive-suffix', ['prefix', 'prefix-sensitive-suffix']),
    ).toBe('token=[REDACTED]');
  });

  it('redacts only own object and array properties', () => {
    const inherited = { own: { token: 'own-secret' } };
    Object.setPrototypeOf(inherited, { token: 'inherited-secret' });
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
    const value = parseJson(
      '{"constructor":"constructor-secret","prototype":"prototype-secret","__proto__":"proto-secret","nested":{"constructor":{"prototype":{"__proto__":"deep-secret"}}}}',
    );

    const redacted = parseJson(
      redactEventEvidence(
        value,
        ['/constructor', '/prototype', '/__proto__', '/nested/constructor/prototype/__proto__'],
        [],
      ),
    );

    if (!isJsonObject(redacted)) throw new Error('Expected redacted object');
    expect(Object.hasOwn(redacted, 'constructor')).toBe(true);
    expect(redacted['constructor']).toBe('[REDACTED]');
    expect(Object.hasOwn(redacted, 'prototype')).toBe(true);
    expect(redacted['prototype']).toBe('[REDACTED]');
    expect(Object.hasOwn(redacted, '__proto__')).toBe(true);
    expect(redacted['__proto__']).toBe('[REDACTED]');
    const nested = redacted['nested'];

    if (nested === undefined || !isJsonObject(nested)) throw new Error('Expected nested object');
    const constructor = nested['constructor'];

    if (constructor === undefined || !isJsonObject(constructor))
      throw new Error('Expected constructor object');
    const prototype = constructor['prototype'];

    if (prototype === undefined || !isJsonObject(prototype))
      throw new Error('Expected prototype object');
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
