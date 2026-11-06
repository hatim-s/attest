import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Retains extension fields while decoding each declared field through its owner. */
const looseStruct = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);

/** Removes only this object's extension keys, leaving nested object policies intact. */
const stripStruct = <const F extends Schema.Struct.Fields>(fields: F) => {
  const declared = Schema.Struct(fields);
  const source = looseStruct(fields);

  return source.pipe(
    Schema.decodeTo(Schema.toType(declared), {
      decode: SchemaGetter.transform((value): Schema.Struct.Type<F> => {
        // BOUNDARY: The native loose schema has already validated declared fields; extension values remain unknown.
        const output: Mutable<typeof value> = { ...value };

        for (const key of Object.keys(output)) {
          if (!Object.hasOwn(fields, key)) delete output[key];
        }

        // SAFETY: Only undeclared keys were removed; all declared fields already passed their owner schemas.
        return output as Schema.Struct.Type<F>;
      }),
      // SAFETY: A declared struct is the same decoded object with no extension keys.
      encode: SchemaGetter.transform((value) => ({ ...value }) as typeof source.Type),
    }),
  );
};

export { looseStruct, stripStruct };
