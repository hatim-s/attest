import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';
import * as Option from 'effect/Option';
import { stripStruct, looseStruct } from '../schema/objects.js';

import {
  SchemaDecodeError,
  formatContractIssues,
  parseWithSchema,
  parseWithSchemaEffect,
  parseWithSchemaSync,
} from '../schema/parse.js';
import type { Result } from '../result.js';

// BOUNDARY: These inputs exercise unknown JSON at the public decoder boundary.
const decodeFixture = (candidate: unknown) => {
  const schema = stripStruct({
    name: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed('default'))),
    count: Schema.Finite.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(3)))),
  });

  return parseWithSchema(schema, candidate);
};

describe('public schema decoding', () => {
  it('preserves strip, loose, strict, defaults and catch behavior', () => {
    expect(decodeFixture({ count: 'bad', extra: true })).toEqual({
      ok: true,
      value: { name: 'default', count: 3 },
    });
    const fields = { name: Schema.String };
    expect(parseWithSchemaSync(looseStruct(fields), { name: 'a', extra: 1 })).toEqual({
      name: 'a',
      extra: 1,
    });
    const strict = parseWithSchema(Schema.Struct(fields), { name: 'a', extra: 1, other: 2 });
    expect(strict.ok).toBe(false);

    if (strict.ok) throw new Error('Expected strict rejection');
    expect(formatContractIssues(strict.error.issues)).toEqual([
      { path: 'extra', message: 'Expected no excess property' },
      { path: 'other', message: 'Expected no excess property' },
    ]);
  });

  it('retains error identity, authored paths and synchronous throws', () => {
    const schema = stripStruct({ items: Schema.Array(Schema.String) }).check(
      Schema.makeFilter((value) =>
        value.items.length === 0
          ? { path: ['items', 0], issue: 'at least one authored item' }
          : undefined,
      ),
    );

    const failure = parseWithSchema(schema, { items: [] });

    if (failure.ok) throw new Error('Expected refinement rejection');
    expect(failure.error).toBeInstanceOf(SchemaDecodeError);
    expect(formatContractIssues(failure.error.issues)).toEqual([
      { path: 'items.0', message: 'at least one authored item' },
    ]);
    expect(() => parseWithSchemaSync(schema, { items: [] })).toThrow(failure.error.message);
    const defect = new Error('refinement defect');

    const throwing = Schema.String.check(
      Schema.makeFilter(() => {
        throw defect;
      }),
    );

    expect(() => parseWithSchema(throwing, 'a')).toThrow(defect);
    expect(() => parseWithSchemaSync(throwing, 'a')).toThrow(defect);
  });

  it('keeps Effect decoding lazy and failures in E with inferred transformed output', () => {
    let decodes = 0;

    const schema = Schema.String.pipe(
      Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transform((value) => {
          decodes++;

          return value.length;
        }),
        encode: SchemaGetter.transform(String),
      }),
    );

    const operation = parseWithSchemaEffect(schema, 'abc');
    expect(decodes).toBe(0);
    expectTypeOf(operation).toEqualTypeOf<Effect.Effect<number, SchemaDecodeError>>();
    expectTypeOf(parseWithSchema(schema, 'abc')).toEqualTypeOf<Result<number, SchemaDecodeError>>();
    expectTypeOf(parseWithSchemaSync(schema, 'abc')).toEqualTypeOf<number>();
    // Type assertions above execute synchronous decoding too.
    const before = decodes;
    expect(Effect.runSync(operation)).toBe(3);
    expect(decodes).toBe(before + 1);
    const failure = Effect.runSync(Effect.flip(parseWithSchemaEffect(schema, 7)));
    expect(failure).toBeInstanceOf(SchemaDecodeError);
    expect(failure.issues[0]?.path).toEqual([]);
  });
});

describe('native diagnostic invariants', () => {
  it('retains native causes and reports empty unions', () => {
    const failure = parseWithSchema(Schema.Union([]), 'anything');

    if (failure.ok) throw new Error('Expected empty union rejection');
    expect(failure.error.cause).toBeInstanceOf(Schema.SchemaError);
    expect(failure.error.issues).toEqual([expect.objectContaining({ code: 'AnyOf', path: [] })]);
  });
  it('keeps every independent authored refinement path', () => {
    const schema = Schema.Struct({ value: Schema.String }).check(
      Schema.makeFilter(() => [
        { path: ['a'], issue: 'first' },
        { path: ['b', 1], issue: 'second' },
      ]),
      Schema.makeFilter(() => ({ path: ['c'], issue: 'third' })),
    );

    const failure = parseWithSchema(schema, { value: 'x' });

    if (failure.ok) throw new Error('Expected refinement rejection');
    expect(formatContractIssues(failure.error.issues)).toEqual([
      { path: 'a', message: 'first' },
      { path: 'b.1', message: 'second' },
      { path: 'c', message: 'third' },
    ]);
  });
  it('distinguishes missing keys from present undefined and preserves refinement defects', () => {
    const schema = Schema.Struct({
      optional: Schema.optional(Schema.String),
      key: Schema.optionalKey(Schema.String),
    });

    expect(parseWithSchemaSync(schema, {})).toEqual({});
    expect(Object.hasOwn(parseWithSchemaSync(schema, { optional: undefined }), 'optional')).toBe(
      true,
    );
    expect(parseWithSchema(schema, { key: undefined }).ok).toBe(false);
    const defect = new Error('authored defect');

    const exit = Effect.runSync(
      Effect.exit(
        parseWithSchemaEffect(
          Schema.String.check(
            Schema.makeFilter(() => {
              throw defect;
            }),
          ),
          'x',
        ),
      ),
    );

    expect(exit._tag).toBe('Failure');

    if (exit._tag === 'Failure') expect(Cause.squash(exit.cause)).toBe(defect);
  });
});
