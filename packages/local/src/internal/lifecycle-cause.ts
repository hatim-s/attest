import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

/** Keeps the primary Cause and attaches every release Cause without replacing its classification. */
const finishWithRelease = <A, E, E2 extends Error>(
  primary: Exit.Exit<A, E>,
  releases: readonly Exit.Exit<unknown, E2>[],
): Effect.Effect<A, E | E2> => {
  const causes = releases.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []));

  if (Exit.isFailure(primary))
    return Effect.failCause(
      causes.length === 0
        ? primary.cause
        : causes.reduce<Cause.Cause<E | E2>>(
            (left, right) => Cause.combine(left, right),
            primary.cause,
          ),
    );

  if (causes.length > 0)
    return Effect.failCause(
      causes.reduce<Cause.Cause<E2>>((left, right) => Cause.combine(left, right), Cause.empty),
    );

  return Effect.succeed(primary.value);
};

export { finishWithRelease };
