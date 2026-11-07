import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { describe, expect, it } from 'vitest';

import { StoreError } from '@attest/core';

import { migrateToLatest } from '../migration-runner.js';
import { StoreCleanup, finishStoreCleanup } from '../internal/store-effect.js';
import type { SqliteHandle } from '../internal/sqlite-handle.js';

/** Models driver failures after a migration begins, including failed compensation. */
const failingMigrationHandle = (primary: Error, rollback: Error): SqliteHandle => ({
  prepare: () => ({
    all: () => Promise.resolve([]),
    run: () => Promise.resolve({ changes: 1 }),
  }),
  exec: (sql) => (sql.includes('CREATE TABLE runs') ? Promise.reject(primary) : Promise.resolve()),
  begin: () => Promise.resolve(),
  commit: () => Promise.resolve(),
  rollback: () => Promise.reject(rollback),
  close: () => Promise.resolve(),
});

describe('migration lifetime', () => {
  it('retains the primary migration error when rollback also fails', async () => {
    const primary = new StoreError('WRITE_FAILED', 'migration statement failed');
    const rollback = new Error('rollback failed');

    const exit = await Effect.runPromiseExit(
      migrateToLatest(failingMigrationHandle(primary, rollback)),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      const failures = exit.cause.reasons.filter(Cause.isFailReason);
      expect(failures.map((reason) => reason.error)).toEqual([primary]);
      expect(Context.getOrUndefined(Cause.annotations(exit.cause), StoreCleanup)).toBeDefined();
    }
  });

  it('settles a pending migration before releasing the handle on interruption', async () => {
    const events: string[] = [];
    let releaseCommit = (): void => undefined;

    const committed = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });

    let notifyCommit = (): void => undefined;

    const committing = new Promise<void>((resolve) => {
      notifyCommit = resolve;
    });

    let notifyInterrupted = (): void => undefined;

    const interrupted = new Promise<void>((resolve) => {
      notifyInterrupted = resolve;
    });

    const handle: SqliteHandle = {
      ...failingMigrationHandle(new Error('unused'), new Error('unused')),
      exec: () => Promise.resolve(),
      commit: async () => {
        events.push('committing');
        notifyCommit();
        await committed;
        events.push('committed');
      },
      close: () => {
        events.push('closed');

        return Promise.resolve();
      },
    };

    const result = Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.ensuring(
            migrateToLatest(handle),
            Effect.promise(() => handle.close()),
          ),
        );

        yield* Effect.promise(() => committing);
        // A synchronous request makes the gate prove interruption happened before commit release.
        fiber.interruptUnsafe();
        notifyInterrupted();
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      }),
    );

    await interrupted;
    expect(events).toEqual(['committing']);
    releaseCommit();
    await result;
    expect(events).toEqual(['committing', 'committed', 'closed']);
  });

  it('surfaces failed cleanup after success and preserves primary defects', async () => {
    const close = new StoreError('WRITE_FAILED', 'close failed');
    const defect = new Error('primary defect');

    const success = await Effect.runPromiseExit(
      finishStoreCleanup(Exit.succeed('read completed'), Exit.fail(close)),
    );

    expect(success).toEqual(Exit.fail(close));

    const failed = await Effect.runPromiseExit(
      finishStoreCleanup(Exit.die(defect), Exit.fail(close)),
    );

    expect(Exit.isFailure(failed)).toBe(true);

    if (Exit.isFailure(failed)) {
      expect(Cause.hasDies(failed.cause)).toBe(true);
      expect(Context.getOrUndefined(Cause.annotations(failed.cause), StoreCleanup)).toBeDefined();
    }
  });
});
