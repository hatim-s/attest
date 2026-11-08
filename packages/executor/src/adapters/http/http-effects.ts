import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { AgentInvocationError, abortedError } from '../../errors.js';

/** Observes an external abort without retaining its listener after the wait ends. */
const awaitAbort = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const abort = (): void => resume(Effect.void);

    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });

    return Effect.sync(() => signal.removeEventListener('abort', abort));
  });

/** A delay is only an observation; cancellation is classified by the evidence owner. */
const httpDelay = Effect.fn('http.delay')(function* (
  ms: number,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
) {
  yield* Effect.raceFirst(Effect.sleep(ms), awaitAbort(signal));

  if (signal.aborted)
    return yield* Effect.fail(abortedError(callerSignal, 'Mapped HTTP invocation'));
});

/** Owns the business deadline and removes every source listener after the invocation joins. */
const withHttpSignal = <A, E, R>(
  ms: number,
  sources: readonly (AbortSignal | undefined)[],
  use: (signal: AbortSignal) => Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const controller = new AbortController();
    const cleanup: Effect.Effect<void>[] = [Effect.sync(() => controller.abort())];

    const operation = Effect.scoped(
      Effect.gen(function* () {
        for (const source of sources) {
          if (source === undefined) continue;
          const abort = (): void => controller.abort(source.reason);

          // Register release before acquisition so partial listener setup is also cleaned up.
          cleanup.push(Effect.sync(() => source.removeEventListener('abort', abort)));

          if (source.aborted) abort();
          else source.addEventListener('abort', abort, { once: true });
        }

        yield* Effect.forkScoped(
          Effect.sleep(ms).pipe(
            Effect.andThen(
              Effect.sync(() => controller.abort(new DOMException('Timed out', 'TimeoutError'))),
            ),
          ),
        );

        return yield* use(controller.signal);
      }),
    );

    // Scope joins the deadline observer before the captured releases select the public result.
    return withHttpCleanup(operation, cleanup);
  });

/** Internal diagnostics remain attached to the selected primary Cause. */
class HttpCleanup extends Context.Service<HttpCleanup, readonly Exit.Exit<unknown, unknown>[]>()(
  'attest/http/cleanup',
) {}

/**
 * Marks an invocation failure unsafe to replay after its cleanup failed, keeping its class, every
 * fact and the primary cause beside the cleanup exits.
 */
const prohibitReplay = (
  error: AgentInvocationError,
  cleanup: readonly Exit.Exit<unknown, unknown>[],
) => error.copyWith({ applicationStarted: true, cause: { primary: error.cause, cleanup } });

/** Joins masked cleanup and keeps the primary failure, interruption or defect authoritative. */
const withHttpCleanup = <A, E, R, R2>(
  primary: Effect.Effect<A, E, R>,
  cleanup: readonly Effect.Effect<unknown, unknown, R2>[],
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(restore(primary));
      const diagnostics: Exit.Exit<unknown, unknown>[] = [];

      for (const release of cleanup) diagnostics.push(yield* Effect.exit(release));
      const failed = diagnostics.some(Exit.isFailure);

      if (Exit.isFailure(outcome)) {
        const previous =
          Context.getOrUndefined(Cause.annotations(outcome.cause), HttpCleanup) ?? [];

        const failure: Cause.Cause<E | AgentInvocationError> = failed
          ? Cause.annotate(
              // Other failures pass through unchanged.
              Cause.map(outcome.cause, (error) =>
                error instanceof AgentInvocationError ? prohibitReplay(error, diagnostics) : error,
              ),
              Context.make(HttpCleanup, [...previous, ...diagnostics]),
              { overwrite: true },
            )
          : outcome.cause;

        return yield* Effect.failCause(failure);
      }

      if (failed)
        return yield* Effect.fail(
          new AgentInvocationError('network', 'HTTP cleanup was not confirmed.', {
            applicationStarted: true,
            cause: { success: outcome.value, cleanup: diagnostics },
          }),
        );

      return outcome.value;
    }),
  );

export { awaitAbort, httpDelay, withHttpSignal, withHttpCleanup, HttpCleanup };
