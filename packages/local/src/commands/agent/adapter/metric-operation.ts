import * as Data from 'effect/Data';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

/** Retains cleanup evidence without replacing a primary failure or defect. */
class MetricCleanupDiagnostics extends Context.Service<
  MetricCleanupDiagnostics,
  { cause: Cause.Cause<unknown> }
>()('attest/LocalMetricCleanupDiagnostics') {}

/** Reports release failure after success, retaining the completed operation's evidence. */
class MetricCleanupError<A = unknown> extends Data.TaggedError('LocalMetricCleanupError')<{
  readonly completed: A;
  readonly cleanupCause: Cause.Cause<unknown>;
  readonly cleanupConfirmed: false;
}> {
  constructor(completed: A, cleanupCause: Cause.Cause<unknown>) {
    super({ completed, cleanupCause, cleanupConfirmed: false });
  }
  override readonly message = 'Metric cleanup failed.';
}

/** Adapts one foreign SDK or filesystem operation, preserving its original Error identity. */
const foreign = <A>(operation: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: (signal) => operation(signal),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error('Foreign operation failed.', { cause }),
  });

/** Captures every release Exit and selects the outcome according to R1 through R3. */
const withRelease = <A, E>(
  operation: Effect.Effect<A, E>,
  release: Effect.Effect<unknown, Error>,
): Effect.Effect<A, E | MetricCleanupError<A>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const primary = yield* Effect.exit(restore(operation));

      const cleanup = yield* Effect.exit(
        Effect.gen(function* () {
          const bounded = yield* Effect.timeoutOption(Effect.interruptible(release), 5_000);

          if (Option.isNone(bounded))
            return yield* Effect.fail(new Error('Metric cleanup is unconfirmed after 5000 ms.'));
        }),
      );

      if (Exit.isFailure(primary)) {
        if (Exit.isSuccess(cleanup)) return yield* Effect.failCause(primary.cause);

        // Each primary branch can own different cleanup evidence; the merged annotations are lossy.
        const causes = new Set(
          primary.cause.reasons.flatMap((reason) => {
            const previous = Context.getOrUndefined(
              Cause.reasonAnnotations(reason),
              MetricCleanupDiagnostics,
            );

            return previous === undefined ? [] : [previous.cause];
          }),
        );

        return yield* Effect.failCause(
          Cause.annotate(
            primary.cause,
            Context.make(MetricCleanupDiagnostics, {
              cause: Cause.fromReasons([
                ...[...causes].flatMap((cause) => cause.reasons),
                ...cleanup.cause.reasons,
              ]),
            }),
            { overwrite: true },
          ),
        );
      }

      if (Exit.isFailure(cleanup))
        return yield* Effect.fail(new MetricCleanupError(primary.value, cleanup.cause));

      return primary.value;
    }),
  );

export { foreign, withRelease, MetricCleanupError, MetricCleanupDiagnostics };
