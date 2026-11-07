import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { describe, expect, it } from 'vitest';

import {
  EnvironmentCleanupDiagnostics,
  EnvironmentCleanupError,
  EnvironmentOperationEvidence,
  ownOperation,
  withRelease,
} from '../operation.js';

describe('native environment ownership', () => {
  it('retains completed evidence when release defects after success', async () => {
    const evidence = { stdout: 'complete', exitCode: 0 };
    const defect = new Error('release defect');

    const exit = await Effect.runPromiseExit(
      withRelease(Effect.succeed(evidence), Effect.die(defect)),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isSuccess(exit)) throw new Error('Expected cleanup failure');
    const error = exit.cause.reasons[0];
    expect(error).toMatchObject({ _tag: 'Fail', error: { completed: evidence } });

    if (!Cause.isFailReason(error!)) throw new Error('Expected typed cleanup error');
    expect(error.error).toBeInstanceOf(EnvironmentCleanupError);
  });

  it.each(['failure', 'defect', 'interruption'] as const)(
    'retains primary %s and cleanup Cause',
    async (kind) => {
      const primary = new Error('primary');
      const cleanup = new Error('release');

      const operation =
        kind === 'failure'
          ? Effect.fail(primary)
          : kind === 'defect'
            ? Effect.die(primary)
            : Effect.interrupt;

      const exit = await Effect.runPromiseExit(withRelease(operation, Effect.die(cleanup)));

      if (Exit.isSuccess(exit)) throw new Error('Expected primary failure');
      expect(Cause.hasDies(exit.cause)).toBe(kind === 'defect');
      expect(Cause.hasInterrupts(exit.cause)).toBe(kind === 'interruption');

      if (kind === 'failure')
        expect(exit.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: primary });

      const diagnostic = Context.getOrUndefined(
        Cause.annotations(exit.cause),
        EnvironmentCleanupDiagnostics,
      );

      expect(diagnostic?.cause.reasons[0]).toMatchObject({ _tag: 'Die', defect: cleanup });
    },
  );

  it('retains both nested cleanup failures beside the original failure', async () => {
    const primary = new Error('primary');
    const inner = new Error('inner release');
    const outer = new Error('outer release');

    const exit = await Effect.runPromiseExit(
      withRelease(withRelease(Effect.fail(primary), Effect.die(inner)), Effect.fail(outer)),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected primary failure.');
    expect(exit.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: primary });

    const cleanup = Context.getOrUndefined(
      Cause.annotations(exit.cause),
      EnvironmentCleanupDiagnostics,
    );

    expect(cleanup?.cause.reasons.find(Cause.isDieReason)?.defect).toBe(inner);
    expect(cleanup?.cause.reasons.find(Cause.isFailReason)?.error).toBe(outer);
  });

  it('turns cancellation into an input and joins completed evidence before interruption', async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();

        const worker = yield* Effect.forkChild(
          ownOperation((signal) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) =>
                    signal.aborted
                      ? resolve()
                      : signal.addEventListener('abort', () => resolve(), { once: true }),
                  ),
              );

              return 'drained evidence';
            }),
          ),
        );

        yield* Deferred.await(started);
        yield* Fiber.interrupt(worker);

        return yield* Fiber.await(worker);
      }),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected interruption');
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);

    const evidence = Context.getOrUndefined(
      Cause.annotations(exit.cause),
      EnvironmentOperationEvidence,
    );

    expect(evidence?.exit).toEqual(Exit.succeed('drained evidence'));
  });
});
