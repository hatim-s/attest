import * as Data from 'effect/Data';
import * as Fiber from 'effect/Fiber';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

/** Retains cleanup evidence without replacing a primary failure or defect. */
class MetricCleanupDiagnostics extends Context.Service<
  MetricCleanupDiagnostics,
  { cause: Cause.Cause<unknown> }
>()('attest/MetricCleanupDiagnostics') {}

/** Reports release failure after success, retaining the completed operation's evidence. */
class MetricCleanupError<A = unknown> extends Data.TaggedError('MetricCleanupError')<{
  readonly completed: A;
  readonly cleanupCause: Cause.Cause<unknown>;
  readonly cleanupConfirmed: false;
}> {
  constructor(completed: A, cleanupCause: Cause.Cause<unknown>) {
    super({ completed, cleanupCause, cleanupConfirmed: false });
  }
  override readonly message = 'Metric cleanup failed.';
}

/** Keeps defects, interruptions and resource-release receipts out of metric-result conversion. */
const mustPropagateMetricCause = <E>(cause: Cause.Cause<E>): boolean =>
  Cause.hasDies(cause) || Cause.hasInterrupts(cause) || hasMetricCleanupFailure(cause);

/** Adapts one foreign SDK or filesystem operation, preserving its original Error identity. */
const foreign = <A>(operation: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: (signal) => operation(signal),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error('Foreign operation failed.', { cause }),
  });

/** Keeps the completed child Exit when cancellation wins the caller's wait. */
class MetricOperationEvidence extends Context.Service<
  MetricOperationEvidence,
  { exit: Exit.Exit<unknown, Error> }
>()('attest/MetricOperationEvidence') {}

/** Checks direct and joined-operation cleanup before a shared judge call may be retried. */
const hasMetricCleanupFailure = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    const annotations = Cause.reasonAnnotations(reason);
    const completed = Context.getOrUndefined(annotations, MetricOperationEvidence)?.exit;

    return (
      Context.getOrUndefined(annotations, MetricCleanupDiagnostics) !== undefined ||
      (reason._tag === 'Fail' && reason.error instanceof MetricCleanupError) ||
      (completed !== undefined &&
        Exit.isFailure(completed) &&
        hasMetricCleanupFailure(completed.cause))
    );
  });

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
      controller.abort(new Error('Metric owner interrupted.'));
      const completed = yield* Fiber.await(child);

      return yield* Effect.failCause(
        Cause.annotate(waiting.cause, Context.make(MetricOperationEvidence, { exit: completed })),
      );
    }),
  );

/** Captures every release Exit and selects the outcome according to R1 through R3. */
const withRelease = <A, E>(
  operation: Effect.Effect<A, E>,
  release: Effect.Effect<unknown, Error>,
): Effect.Effect<A, E | MetricCleanupError<A>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const primary = yield* Effect.exit(restore(operation));

      const cleanup = yield* Effect.exit(release);

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

/** Attempts every release and retains all failures, including defects, in one Cause. */
const releaseAll = (releases: readonly Effect.Effect<unknown, Error>[]) =>
  Effect.gen(function* () {
    let cause: Cause.Cause<Error> = Cause.empty;

    for (const release of releases) {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const bounded = yield* Effect.timeoutOption(Effect.interruptible(release), 5_000);

          if (Option.isNone(bounded))
            return yield* Effect.fail(new Error('Metric cleanup is unconfirmed after 5000 ms.'));
        }),
      );

      if (Exit.isFailure(exit))
        cause = Cause.fromReasons([...cause.reasons, ...exit.cause.reasons]);
    }

    if (cause.reasons.length > 0) return yield* Effect.failCause(cause);
  });

export {
  mustPropagateMetricCause,
  hasMetricCleanupFailure,
  releaseAll,
  foreign,
  withRelease,
  ownOperation,
  MetricCleanupError,
  MetricCleanupDiagnostics,
  MetricOperationEvidence,
};
