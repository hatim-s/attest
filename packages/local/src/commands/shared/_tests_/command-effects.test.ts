import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Fiber from 'effect/Fiber';
import * as Exit from 'effect/Exit';
import { describe, expect, it } from 'vitest';
import { ReleaseFailure } from '../../../_tests_/support/release-failure.js';
import { LocalError } from '../../../errors/index.js';
import { CommandCleanup, withCommandCleanup } from '../command-cleanup.js';
import { readCommandRequest } from '../command-request.js';

/** Extracts the owned typed failure without flattening runtime defects. */
const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error('Expected a failed operation.');

  return exit.cause;
};

describe('native command failure and cleanup precedence', () => {
  it('attempts every release and retains successful read evidence', async () => {
    const released: string[] = [];

    const cause = failure(
      await Effect.runPromiseExit(
        withCommandCleanup(Effect.succeed('read bytes'), [
          Effect.sync(() => {
            released.push('first');
            throw new Error('close defect');
          }),
          Effect.sync(() => {
            released.push('second');
          }),
          Effect.fail(new ReleaseFailure({ message: 'second close failed' })),
        ]),
      ),
    );

    expect(released).toEqual(['first', 'second']);
    const reason = cause.reasons.find(Cause.isFailReason);
    expect(reason?.error).toBeInstanceOf(LocalError);

    if (!(reason?.error instanceof LocalError)) throw new Error('Missing cleanup error.');
    expect(reason.error.cause).toHaveProperty('success', 'read bytes');
    expect(reason.error.cause).toHaveProperty('cleanup');
  });

  it('keeps the primary typed error and its cleanup diagnostics', async () => {
    const primary = new LocalError('cancelled', 'User declined.');

    const cause = failure(
      await Effect.runPromiseExit(
        withCommandCleanup(Effect.fail(primary), [Effect.die('release defect')]),
      ),
    );

    expect(cause.reasons.find(Cause.isFailReason)?.error).toBe(primary);
    expect(Context.getOrUndefined(Cause.annotations(cause), CommandCleanup)).toHaveLength(1);
  });

  it('preserves defects and interruption when cleanup also fails', async () => {
    for (const primary of [Effect.die('primary defect'), Effect.interrupt]) {
      const cause = failure(
        await Effect.runPromiseExit(withCommandCleanup(primary, [Effect.fail('release failed')])),
      );

      expect(Cause.hasDies(cause) || Cause.hasInterrupts(cause)).toBe(true);
      expect(cause.reasons.some(Cause.isFailReason)).toBe(false);
      expect(Context.getOrUndefined(Cause.annotations(cause), CommandCleanup)).toHaveLength(1);
    }
  });

  it('interrupts a pending read from outside and joins every release with its diagnostics', async () => {
    const released: string[] = [];
    const closeError = new Error('reader close failed');

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const finishRead = yield* Deferred.make<void>();
          const releasesDone = yield* Deferred.make<void>();

          const fiber = yield* Effect.forkScoped(
            withCommandCleanup(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(finishRead);
              }),
              [
                Effect.sleep(10).pipe(
                  Effect.interruptible,
                  Effect.timeoutOption('1 second'),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      released.push('first');
                    }),
                  ),
                ),
                Effect.sync(() => {
                  released.push('second');
                }).pipe(Effect.andThen(Effect.fail(closeError))),
                Effect.sync(() => {
                  released.push('third');
                }).pipe(Effect.andThen(Deferred.succeed(releasesDone, undefined))),
              ],
            ),
          );

          yield* Deferred.await(started);
          const interrupt = yield* Effect.forkScoped(Fiber.interrupt(fiber));

          const observedRelease = yield* Deferred.await(releasesDone).pipe(
            Effect.timeoutOption('250 millis'),
          );

          // Free a masked implementation too, so the negative control cannot leave a stuck fiber.
          yield* Deferred.succeed(finishRead, undefined);
          yield* Fiber.join(interrupt);
          const result = yield* Fiber.await(fiber);
          expect(observedRelease._tag).toBe('Some');
          expect(released).toEqual(['first', 'second', 'third']);
          const cause = failure(result);
          expect(Cause.hasInterrupts(cause)).toBe(true);
          const cleanup = Context.getOrUndefined(Cause.annotations(cause), CommandCleanup);
          expect(cleanup).toHaveLength(1);
          expect(cleanup?.[0]?.reasons.find(Cause.isFailReason)?.error).toBe(closeError);
        }),
      ),
    );

    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  });

  it('retains mixed primary reasons and every nested cleanup annotation', async () => {
    const typedCleanup = Cause.fail('earlier typed release');
    const defectCleanup = Cause.die('earlier defect release');

    const primary = Cause.combine(
      Cause.annotate(
        Cause.fail(new LocalError('cancelled', 'declined')),
        Context.make(CommandCleanup, [typedCleanup]),
      ),
      Cause.annotate(Cause.die('primary defect'), Context.make(CommandCleanup, [defectCleanup])),
    );

    const cause = failure(
      await Effect.runPromiseExit(
        withCommandCleanup(Effect.failCause(primary), [Effect.fail('latest release')]),
      ),
    );

    expect(cause.reasons.some(Cause.isFailReason)).toBe(true);
    expect(Cause.hasDies(cause)).toBe(true);

    for (const reason of cause.reasons) {
      const observations = Context.getOrUndefined(Cause.reasonAnnotations(reason), CommandCleanup);
      expect(observations).toHaveLength(2);
      expect(observations?.[0]).toBe(Cause.isFailReason(reason) ? typedCleanup : defectCleanup);
      expect(observations?.[1]?.reasons.find(Cause.isFailReason)?.error).toBe('latest release');
    }
  });

  it('fails malformed authored requests through E before any project read', async () => {
    const cause = failure(
      await Effect.runPromiseExit(
        readCommandRequest('agent.remove', '-', {
          readStdin: () => Promise.resolve('{}'),
          workingDirectory: '/unopened-project',
        }),
      ),
    );

    expect(Cause.hasDies(cause)).toBe(false);
    expect(cause.reasons.find(Cause.isFailReason)?.error).toMatchObject({ code: 'cli_usage' });
  });
});
