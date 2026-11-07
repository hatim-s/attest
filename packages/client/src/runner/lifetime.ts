import { Cause, Context, Data, Effect, Exit } from 'effect';

/** Annotates a primary Cause with release diagnostics. */
class ClientCleanup extends Context.Service<ClientCleanup, Cause.Cause<unknown>>()(
  'attest/client/Cleanup',
) {}

/** Cleanup failure after success retains the completed value and every release Cause. */
class ClientCleanupError extends Data.TaggedError('ClientCleanupError')<{
  message: string;
  success: unknown;
  cleanup: readonly Cause.Cause<unknown>[];
}> {}

/** Joins owned cleanup or applies its foreign-call bound, preserving every cleanup Cause. */
const withCleanup = <A, E, R, R2>(
  use: Effect.Effect<A, E, R>,
  release: Effect.Effect<unknown, unknown, R2>,
  timeoutMs: number | undefined,
): Effect.Effect<A, E | ClientCleanupError, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const primary = yield* Effect.exit(restore(use));

      const cleanup = yield* Effect.exit(
        timeoutMs === undefined
          ? release
          : Effect.interruptible(release).pipe(Effect.timeout(timeoutMs)),
      );

      if (Exit.isFailure(primary)) {
        if (Exit.isSuccess(cleanup)) return yield* Effect.failCause(primary.cause);

        // Different primary branches can carry different releases; merged annotations lose that detail.
        const previous = new Set(
          primary.cause.reasons.flatMap((reason) => {
            const cause = Context.getOrUndefined(Cause.reasonAnnotations(reason), ClientCleanup);

            return cause === undefined ? [] : [cause];
          }),
        );

        return yield* Effect.failCause(
          Cause.annotate(
            primary.cause,
            Context.make(
              ClientCleanup,
              Cause.fromReasons([
                ...[...previous].flatMap((cause) => cause.reasons),
                ...cleanup.cause.reasons,
              ]),
            ),
            { overwrite: true },
          ),
        );
      }

      if (Exit.isFailure(cleanup))
        return yield* Effect.fail(
          new ClientCleanupError({
            message: 'Client cleanup failed.',
            success: primary.value,
            cleanup: [cleanup.cause],
          }),
        );

      return primary.value;
    }),
  );

export { ClientCleanup, ClientCleanupError, withCleanup };
