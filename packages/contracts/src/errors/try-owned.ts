import * as Effect from 'effect/Effect';

/** Any error class, including abstract ones, matched with `instanceof`. */
type ErrorClass<Owned> = abstract new (...args: never[]) => Owned;

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
  return Effect.try({ try: evaluate, catch: (cause) => cause }).pipe(
    Effect.catch((cause) => {
      if (!(cause instanceof owned)) return Effect.die(cause);

      return Effect.fail(map === undefined ? cause : map(cause));
    }),
  );
}

export { tryOwned };
