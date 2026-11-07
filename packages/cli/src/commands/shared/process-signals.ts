import * as Effect from 'effect/Effect';

/**
 * Runs one command with SIGINT and SIGTERM turned into an abort signal. The listeners are removed
 * afterwards so an embedding process keeps its own signal handling.
 */
const withProcessSignals = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  try {
    return await run(controller.signal);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
};

/** Owns command signal listeners for the complete native operation lifetime. */
const withCommandSignals = <A, E, R>(
  run: (signal: AbortSignal) => Effect.Effect<A, E, R>,
  controller = new AbortController(),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const abort = () => controller.abort();
          process.once('SIGINT', abort);
          process.once('SIGTERM', abort);

          return { controller, abort };
        }),
        ({ controller, abort }) =>
          Effect.sync(() => {
            controller.abort();
            process.off('SIGINT', abort);
            process.off('SIGTERM', abort);
          }),
      );

      return yield* run(controller.signal);
    }),
  );

export { withProcessSignals, withCommandSignals };
