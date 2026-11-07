import * as Effect from 'effect/Effect';

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

export { withCommandSignals };
