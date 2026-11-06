import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { timestampSchema, ulidSchema } from '../schema/scalars.js';
import { looseStruct, stripStruct } from '../schema/objects.js';
import { parseWithSchema, parseWithSchemaSync as decode } from '../schema/parse.js';

describe('native object policy composition', () => {
  it.each([
    '80000000000000000000000000',
    'Z0000000000000000000000000',
    'z0000000000000000000000000',
  ])('preserves the accepted identity alphabet for %s', (value) => {
    expect(decode(ulidSchema, value)).toBe(value);
  });
  it.each([
    'I0000000000000000000000000',
    '0000000000000000000000000',
    '000000000000000000000000000',
  ])('rejects invalid identity alphabet or length %s', (value) => {
    expect(parseWithSchema(ulidSchema, value).ok).toBe(false);
  });
  it('strips locally, preserves loose children and rejects strict children', () => {
    const schema = stripStruct({
      loose: looseStruct({ x: Schema.String }),
      strict: Schema.Struct({ x: Schema.String }),
    });

    expect(
      decode(schema, { loose: { x: 'a', extra: 1 }, strict: { x: 'b' }, extra: true }),
    ).toEqual({ loose: { x: 'a', extra: 1 }, strict: { x: 'b' } });
    expect(() => decode(schema, { loose: { x: 'a' }, strict: { x: 'b', extra: 1 } })).toThrow();
    expect(
      decode(Schema.Struct({ child: stripStruct({ x: Schema.String }) }), {
        child: { x: 'a', extra: 1 },
      }),
    ).toEqual({ child: { x: 'a' } });
  });
  it.each(['2024-02-29T12:34Z', '2024-02-29T12:34+05:30'])(
    'preserves minute precision %s',
    (value) => {
      expect(decode(timestampSchema, value)).toBe(value);
    },
  );
  it.each([
    '2025-02-30T00:00:00Z',
    '2025-13-01T00:00:00Z',
    '2025-01-01T25:00:00Z',
    'not a timestamp',
  ])('rejects malformed timestamp %s', (value) => {
    expect(() => decode(timestampSchema, value)).toThrow();
  });
  it('collects independent nested failures under global all/error options', () => {
    const result = parseWithSchema(stripStruct({ a: Schema.String, b: Schema.String }), {
      a: 1,
      b: 2,
      extra: true,
    });

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error.issues.map(({ path }) => path)).toEqual([['a'], ['b']]);
  });
});
