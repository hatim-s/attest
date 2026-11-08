import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

/** Any error class, including abstract ones, matched with `instanceof`. */
type ErrorClass<Owned> = abstract new (...args: never[]) => Owned;

/**
 * Claims a thrown or rejected value as an expected failure, or returns `undefined` to leave it a
 * defect. Callers decide ownership here once instead of catching everything and re-dying later.
 */
type Classify<E> = (cause: unknown) => E | undefined;

/** Turns one thrown or rejected value into the Exit its classifier asks for. */
const settle = <E>(cause: unknown, own: Classify<E>): Exit.Exit<never, E> => {
  const owned = own(cause);

  // The defect is the original value, so a programming error keeps its own stack and identity.
  return owned === undefined ? Exit.die(cause) : Exit.fail(owned);
};

/**
 * Runs a synchronous step whose expected throws `own` claims as typed failures. Anything `own`
 * returns `undefined` for stays a defect carrying the original thrown value.
 */
const tryClassify = <A, E>(evaluate: () => A, own: Classify<E>): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(evaluate());
    } catch (cause) {
      return settle(cause, own);
    }
  });

/**
 * Runs a foreign Promise whose expected rejections `own` claims as typed failures. The signal
 * aborts when the fiber is interrupted. A synchronous throw from `evaluate` is classified like a
 * rejection, as `Effect.tryPromise` does.
 */
const tryPromiseClassify = <A, E>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
  own: Classify<E>,
): Effect.Effect<A, E> =>
  Effect.flatten(
    Effect.promise((signal) =>
      Promise.resolve()
        .then(() => evaluate(signal))
        .then(
          (value): Exit.Exit<A, E> => Exit.succeed(value),
          (cause: unknown) => settle(cause, own),
        ),
    ),
  );

/**
 * Runs a synchronous step whose only expected failure is an instance of `owned`. That error
 * fails the Effect, passed through `map` when given; anything else thrown stays a defect, so a
 * programming error never turns into a typed failure.
 */
function tryOwned<A, Owned>(owned: ErrorClass<Owned>, evaluate: () => A): Effect.Effect<A, Owned>;

function tryOwned<A, Owned, E>(
  owned: ErrorClass<Owned>,
  evaluate: () => A,
  map: (error: Owned) => E,
): Effect.Effect<A, E>;

function tryOwned<A, Owned, E>(
  owned: ErrorClass<Owned>,
  evaluate: () => A,
  map?: (error: Owned) => E,
): Effect.Effect<A, Owned | E> {
  return tryClassify(evaluate, (cause): Owned | E | undefined => {
    if (!(cause instanceof owned)) return undefined;

    return map === undefined ? cause : map(cause);
  });
}

/** Reads a foreign failure's message, or `fallback` when the thrown value is not an Error. */
const foreignMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export { foreignMessage, tryClassify, tryOwned, tryPromiseClassify, type Classify };
