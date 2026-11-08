import * as Semaphore from 'effect/Semaphore';
import { ownOperation } from './operation.js';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import { EnvironmentOperationError } from './environment-error.js';

type EnvironmentLifecycleOptions<Poisoned> = {
  signal: AbortSignal;
  finalizationTimeoutMs: number;
  /** The owner's poison reason, reported to every operation after poisoning. */
  poisonedError?: () => Poisoned | undefined;
};

type Phase = 'run' | 'transitioning' | 'finalizing' | 'poisoned' | 'disposed';

/** Owns operation admission and drains every admitted operation before phase transitions. */
const createEnvironmentLifecycle = <Poisoned = never>(
  options: EnvironmentLifecycleOptions<Poisoned>,
) => {
  const runLifetime = new AbortController();
  const finalizationLifetime = new AbortController();
  const transitionLock = Semaphore.makeUnsafe(1);
  const pending = new Set<Deferred.Deferred<void>>();
  let phase: Phase = 'run';
  let finalSignal: AbortSignal | undefined;

  const stateError = (): EnvironmentOperationError | Poisoned | undefined => {
    if (phase === 'disposed')
      return new EnvironmentOperationError({ reason: 'environment_disposed' });

    if (phase === 'poisoned')
      return (
        options.poisonedError?.() ??
        new EnvironmentOperationError({ reason: 'environment_poisoned' })
      );

    if (phase === 'transitioning')
      return new EnvironmentOperationError({ reason: 'environment_finalizing' });

    return undefined;
  };

  const drain = Effect.fn('environment.drain')(function* () {
    yield* Effect.forEach([...pending], (done) => Deferred.await(done), {
      concurrency: 'unbounded',
    });
  });

  const track = <A, E>(
    operation: (signal: AbortSignal) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | EnvironmentOperationError | Poisoned> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const error = stateError();

        if (error !== undefined) return yield* Effect.fail(error);
        const admitted = finalSignal ?? AbortSignal.any([options.signal, runLifetime.signal]);
        const done = yield* Deferred.make<void>();
        pending.add(done);

        return yield* Effect.ensuring(
          restore(
            ownOperation((cancelled) =>
              Effect.gen(function* () {
                const signal = AbortSignal.any([cancelled, admitted]);

                if (signal.aborted)
                  return yield* EnvironmentOperationError.from(
                    signal.reason,
                    'case_operation_aborted',
                  );

                return yield* operation(signal);
              }),
            ),
          ),
          Effect.gen(function* () {
            pending.delete(done);
            yield* Deferred.succeed(done, undefined);
          }),
        );
      }),
    );

  const beginFinalization = Effect.fn('environment.beginFinalization')(function* () {
    const error = stateError();

    if (error !== undefined) return yield* Effect.fail(error);

    if (phase === 'finalizing') return;
    phase = 'transitioning';
    runLifetime.abort(new Error('Case run operations cancelled for finalization.'));
    yield* drain();

    // Poison or disposal may have won while the admitted work drained.
    if (phase !== 'transitioning')
      return yield* Effect.fail(
        stateError() ?? new EnvironmentOperationError({ reason: 'phase_changed' }),
      );
    finalSignal = AbortSignal.any([
      finalizationLifetime.signal,
      AbortSignal.timeout(options.finalizationTimeoutMs),
    ]);
    phase = 'finalizing';
  });

  return {
    track,
    beginFinalization: () =>
      Effect.uninterruptible(transitionLock.withPermits(1)(beginFinalization())),
    poison: (reason: Error): void => {
      if (phase !== 'disposed') phase = 'poisoned';
      runLifetime.abort(reason);
      finalizationLifetime.abort(reason);
    },
    close: (reason: Error) =>
      Effect.gen(function* () {
        phase = 'disposed';
        runLifetime.abort(reason);
        finalizationLifetime.abort(reason);
        yield* drain();
      }),
  };
};

type EnvironmentLifecycle = ReturnType<typeof createEnvironmentLifecycle>;

export { createEnvironmentLifecycle, type EnvironmentLifecycle };
