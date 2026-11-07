import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { LocalError } from '../../errors/index.js';

/** Retains failed releases on a primary failure, defect, or interruption. */
class CommandCleanup extends Context.Service<CommandCleanup, readonly Cause.Cause<unknown>[]>()(
  'attest/CommandCleanup',
) {}

/** Attempts every release and preserves the primary outcome and successful read evidence. */
const withCommandCleanup = <A, E, R>(
  use: Effect.Effect<A, E, R>,
  releases: readonly Effect.Effect<unknown, unknown>[],
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const primary = yield* Effect.exit(restore(use));
      const failures: Cause.Cause<unknown>[] = [];

      for (const release of releases) {
        const result = yield* Effect.exit(release);

        if (Exit.isFailure(result)) failures.push(result.cause);
      }

      if (failures.length > 0) {
        if (Exit.isFailure(primary))
          return yield* Effect.failCause(
            Cause.fromReasons(
              primary.cause.reasons.map((reason) =>
                reason.annotate(
                  Context.make(CommandCleanup, [
                    ...(Context.getOrUndefined(Cause.reasonAnnotations(reason), CommandCleanup) ??
                      []),
                    ...failures,
                  ]),
                  { overwrite: true },
                ),
              ),
            ),
          );

        return yield* Effect.fail(
          new LocalError('cli_usage', 'Resource read completed but cleanup failed.', {
            cause: { success: primary.value, cleanup: failures },
          }),
        );
      }

      return yield* primary;
    }),
  );

export { CommandCleanup, withCommandCleanup };
