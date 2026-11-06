import { Effect } from 'effect';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  formatContractIssues,
  parseWithSchema,
  parseWithSchemaEffect,
  parseWithSchemaSync,
} from '../schema/parse.js';
import type { Result } from '../result.js';

// BOUNDARY: These inputs exercise unknown JSON at the public decoder boundary.
const decodeFixture = (candidate: unknown) => {
  const schema = z.object({ name: z.string().default('default'), count: z.number().catch(3) });

  return parseWithSchema(schema, candidate);
};

describe('public schema decoding', () => {
  it('preserves strip, loose, strict, defaults and catch behavior', () => {
    expect(decodeFixture({ count: 'bad', extra: true })).toEqual({
      ok: true,
      value: { name: 'default', count: 3 },
    });
    const fields = { name: z.string() };
    expect(parseWithSchemaSync(z.looseObject(fields), { name: 'a', extra: 1 })).toEqual({
      name: 'a',
      extra: 1,
    });
    const strict = parseWithSchema(z.strictObject(fields), { name: 'a', extra: 1, other: 2 });
    expect(strict.ok).toBe(false);

    if (strict.ok) throw new Error('Expected strict rejection');
    expect(formatContractIssues(strict.error.issues)).toEqual([
      { path: 'extra', message: 'Unrecognized keys: "extra", "other"' },
      { path: 'other', message: 'Unrecognized keys: "extra", "other"' },
    ]);
  });

  it('retains error identity, authored paths and synchronous throws', () => {
    const schema = z.object({ items: z.array(z.string()) }).superRefine((value, context) => {
      if (value.items.length === 0)
        context.addIssue({
          code: 'custom',
          path: ['items', 0],
          message: 'at least one authored item',
        });
    });

    const failure = parseWithSchema(schema, { items: [] });

    if (failure.ok) throw new Error('Expected refinement rejection');
    expect(failure.error).toBeInstanceOf(z.ZodError);
    expect(formatContractIssues(failure.error.issues)).toEqual([
      { path: 'items.0', message: 'at least one authored item' },
    ]);
    expect(() => parseWithSchemaSync(schema, { items: [] })).toThrow(failure.error.message);
    const defect = new Error('refinement defect');

    const throwing = z.string().transform(() => {
      throw defect;
    });

    expect(() => parseWithSchema(throwing, 'a')).toThrow(defect);
    expect(() => parseWithSchemaSync(throwing, 'a')).toThrow(defect);
  });

  it('keeps Effect decoding lazy and failures in E with inferred transformed output', () => {
    let decodes = 0;

    const schema = z.string().transform((value) => {
      decodes++;

      return value.length;
    });

    const operation = parseWithSchemaEffect(schema, 'abc');
    expect(decodes).toBe(0);
    expectTypeOf(operation).toEqualTypeOf<Effect.Effect<number, z.ZodError<number>>>();
    expectTypeOf(parseWithSchema(schema, 'abc')).toEqualTypeOf<
      Result<number, z.ZodError<number>>
    >();
    expectTypeOf(parseWithSchemaSync(schema, 'abc')).toEqualTypeOf<number>();
    // Type assertions above execute synchronous decoding too.
    const before = decodes;
    expect(Effect.runSync(operation)).toBe(3);
    expect(decodes).toBe(before + 1);
    const failure = Effect.runSync(Effect.flip(parseWithSchemaEffect(schema, 7)));
    expect(failure).toBeInstanceOf(z.ZodError);
    expect(failure.issues[0]?.path).toEqual([]);
  });
});
