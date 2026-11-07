import * as Fiber from 'effect/Fiber';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

/** Retains cleanup evidence without replacing a primary failure or defect. */
class EnvironmentCleanupDiagnostics extends Context.Service<
  EnvironmentCleanupDiagnostics,
  { cause: Cause.Cause<unknown> }
>()('attest/EnvironmentCleanupDiagnostics') {}

/** Reports release failure after success, retaining the completed operation's evidence. */
class EnvironmentCleanupError<A = unknown> extends Error {
  readonly cleanupConfirmed = false;
  constructor(
    readonly completed: A,
    readonly cleanupCause: Cause.Cause<unknown>,
  ) {
    super('Environment cleanup failed.', { cause: cleanupCause });
  }
}

/** Adapts one foreign SDK or filesystem operation, preserving its original Error identity. */
const foreign = <A>(operation: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: (signal) => operation(signal),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error('Foreign operation failed.', { cause }),
  });

/** Keeps the completed child Exit when cancellation wins the caller's wait. */
class EnvironmentOperationEvidence extends Context.Service<
  EnvironmentOperationEvidence,
  { exit: Exit.Exit<unknown, Error> }
>()('attest/EnvironmentOperationEvidence') {}

/** Reads release failures without exposing environment annotation keys to consumers. */
const getEnvironmentCleanupCause = (
  cause: Cause.Cause<unknown>,
): Cause.Cause<unknown> | undefined => {
  const releases = cause.reasons.flatMap((reason) => {
    const annotations = Cause.reasonAnnotations(reason);
    const cleanup = Context.getOrUndefined(annotations, EnvironmentCleanupDiagnostics)?.cause;
    const completed = Context.getOrUndefined(annotations, EnvironmentOperationEvidence)?.exit;

    const retained =
      completed !== undefined && Exit.isFailure(completed)
        ? getEnvironmentCleanupCause(completed.cause)
        : undefined;

    return [
      ...(cleanup?.reasons ?? []),
      ...(reason._tag === 'Fail' && reason.error instanceof EnvironmentCleanupError
        ? reason.error.cleanupCause.reasons
        : []),
      ...(retained?.reasons ?? []),
    ];
  });

  return releases.length === 0 ? undefined : Cause.fromReasons(releases);
};

/** Turns fiber cancellation into an owner input and joins evidence before returning interruption. */
const ownOperation = <A>(
  operation: (signal: AbortSignal) => Effect.Effect<A, Error>,
): Effect.Effect<A, Error> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const controller = new AbortController();

      const child = yield* Effect.forkChild(operation(controller.signal), {
        uninterruptible: true,
      });

      const waiting = yield* Effect.exit(restore(Fiber.join(child)));

      if (Exit.isSuccess(waiting)) return waiting.value;

      if (!Cause.hasInterrupts(waiting.cause)) return yield* Effect.failCause(waiting.cause);
      controller.abort(new Error('Environment owner interrupted.'));
      const completed = yield* Fiber.await(child);

      return yield* Effect.failCause(
        Cause.annotate(
          waiting.cause,
          Context.make(EnvironmentOperationEvidence, { exit: completed }),
        ),
      );
    }),
  );

/** Captures every release Exit and selects the outcome according to R1 through R3. */
const withRelease = <A, E>(
  operation: Effect.Effect<A, E>,
  release: Effect.Effect<unknown, Error>,
): Effect.Effect<A, E | EnvironmentCleanupError<A>> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const primary = yield* Effect.exit(operation);
      const cleanup = yield* Effect.exit(release);

      if (Exit.isFailure(primary))
        return yield* Effect.failCause(
          Exit.isFailure(cleanup)
            ? Cause.annotate(
                primary.cause,
                Context.make(EnvironmentCleanupDiagnostics, {
                  cause: Cause.combine(
                    Context.getOrUndefined(
                      Cause.annotations(primary.cause),
                      EnvironmentCleanupDiagnostics,
                    )?.cause ?? Cause.empty,
                    cleanup.cause,
                  ),
                }),
                { overwrite: true },
              )
            : primary.cause,
        );

      if (Exit.isFailure(cleanup))
        return yield* Effect.fail(new EnvironmentCleanupError(primary.value, cleanup.cause));

      return primary.value;
    }),
  );

export {
  foreign,
  withRelease,
  ownOperation,
  EnvironmentCleanupError,
  EnvironmentCleanupDiagnostics,
  EnvironmentOperationEvidence,
  getEnvironmentCleanupCause,
};
