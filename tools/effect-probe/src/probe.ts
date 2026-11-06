import { Effect, FiberSet, RcMap, Schema, SchemaGetter } from 'effect';

// Typecheck only. S10 removes this workspace; nothing here runs an Effect.
const strict = Schema.Struct({ name: Schema.String });

const loose = Schema.StructWithRest(strict, [Schema.Record(Schema.String, Schema.Unknown)]);

const strip = loose.pipe(
  Schema.decodeTo(strict, {
    decode: SchemaGetter.transform(({ name }) => ({ name })),
    encode: SchemaGetter.transform((value) => value),
  }),
);

const options = { onExcessProperty: 'error', errors: 'all' } as const;

const strictResult = Schema.decodeUnknownResult(strict, options)({ name: 'fixture', extra: 1 });

const looseResult = Schema.decodeUnknownResult(loose, options)({ name: 'fixture', extra: 1 });

const stripResult = Schema.decodeUnknownResult(
  strip,
  options,
)({
  name: 'fixture',
  extra: 1,
});

const document = Schema.toJsonSchemaDocument(strict, { onExcessProperty: 'error' });

const foreign = Effect.tryPromise((signal: AbortSignal) => Promise.resolve(signal.aborted));

const bracket = Effect.acquireUseRelease(Effect.succeed('resource'), Effect.succeed, () =>
  Effect.fail('cleanup' as const),
);

const bracketError: Effect.Effect<string, 'cleanup', never> = bracket;

// @ts-expect-error acquireUseRelease must retain the release error in E.
const bracketWithoutError: Effect.Effect<string, never, never> = bracket;

// acquireRelease finalizers cannot report expected operational failures.
// @ts-expect-error A fallible release must use acquireUseRelease.
Effect.acquireRelease(Effect.succeed('resource'), () => Effect.fail('cleanup' as const));

const scoped = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const fiber = yield* Effect.forkIn(foreign, scope);
  const set = yield* FiberSet.make<boolean>();
  yield* FiberSet.run(set, foreign);

  const map = yield* RcMap.make({
    lookup: (key: string) => Effect.succeed(key),
    idleTimeToLive: Infinity,
  });

  const value = yield* RcMap.get(map, 'fixture');

  return { fiber, value };
});

export {
  strict,
  loose,
  strip,
  strictResult,
  looseResult,
  stripResult,
  document,
  foreign,
  bracket,
  bracketError,
  bracketWithoutError,
  scoped,
};
