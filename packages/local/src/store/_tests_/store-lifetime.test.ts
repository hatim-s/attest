import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreError } from '@attest/core';
import { openStore, openReadonlyRunStore } from '../run-store.js';
import { withStoreScope, type StoreScope } from '../internal/store-scope.js';
import { StoreCleanup, storeCall } from '../internal/store-effect.js';
import { createCacheStore } from '../cache.js';
import { openSqliteHandle } from '../internal/open-sqlite-handle.js';
import { createSqliteDialect } from '../internal/kysely-sqlite-dialect.js';
import { migrateToLatest } from '../migration-runner.js';
import type { Database } from '../schema.js';
import { run } from './store-fixture.js';

const directories: string[] = [];

const temporaryPath = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-owner-'));
  directories.push(directory);

  return join(directory, 'runs.db');
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

/** Gives foreign work an explicit acknowledgement gate rather than a timed assertion. */
const gate = () => {
  let release = () => {};

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
};

describe('store owner lifetime', () => {
  it('shares one run/cache context per owner and rejects mode changes and escaped methods', async () => {
    const path = await temporaryPath();

    const store = await run(
      withStoreScope((owner) =>
        Effect.gen(function* () {
          const first = yield* openStore(path, owner);
          expect(yield* openStore(path, owner)).toBe(first);
          const mismatch = yield* Effect.exit(openReadonlyRunStore(path, owner));
          expect(Exit.isFailure(mismatch)).toBe(true);
          yield* first.cache.put('judge', 'hash', { score: 1 });
          expect(yield* first.cache.get('judge', 'hash')).toEqual({ score: 1 });

          return first;
        }),
      ),
    );

    await expect(run(store.runs.listRuns())).rejects.toMatchObject({
      code: 'READ_FAILED',
      message: 'Store owner is closed.',
    });
  });

  it('does not cache failed readonly acquisitions or create a missing database', async () => {
    const path = await temporaryPath();
    await run(
      withStoreScope((owner) =>
        Effect.gen(function* () {
          expect(Exit.isFailure(yield* Effect.exit(openReadonlyRunStore(path, owner)))).toBe(true);
          yield* withStoreScope((writer) => Effect.asVoid(openStore(path, writer)));
          const source = yield* openReadonlyRunStore(path, owner);
          expect((yield* source.listRuns()).items).toEqual([]);
        }),
      ),
    );
  });

  it.each(['success', 'failure', 'defect', 'interrupt'] as const)(
    'retains primary %s and every close diagnostic',
    async (kind) => {
      const primary = new StoreError('READ_FAILED', 'primary read');
      const defect = new Error('primary defect');
      const closes: string[] = [];

      const exit = await Effect.runPromiseExit(
        withStoreScope((owner) =>
          Effect.gen(function* () {
            yield* owner.register(
              Effect.andThen(
                Effect.sync(() => closes.push('first')),
                Effect.fail(new StoreError('WRITE_FAILED', 'first close')),
              ),
            );
            yield* owner.register(
              Effect.andThen(
                Effect.sync(() => closes.push('second')),
                Effect.fail(new StoreError('WRITE_FAILED', 'second close')),
              ),
            );

            switch (kind) {
              case 'success':
                return 'read';
              case 'failure':
                return yield* Effect.fail(primary);
              case 'defect':
                return yield* Effect.die(defect);
              case 'interrupt':
                return yield* Effect.interrupt;
            }
          }),
        ),
      );

      expect(closes).toEqual(['second', 'first']);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        if (kind === 'defect')
          expect(exit.cause.reasons.filter(Cause.isDieReason).map((r) => r.defect)).toContain(
            defect,
          );

        if (kind === 'interrupt') expect(Cause.hasInterrupts(exit.cause)).toBe(true);

        if (kind === 'failure')
          expect(exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)).toEqual([
            primary,
          ]);

        if (kind !== 'success')
          expect(
            Context.getOrUndefined(Cause.annotations(exit.cause), StoreCleanup)?.reasons,
          ).toHaveLength(2);
        else
          expect(exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error.code)).toEqual([
            'WRITE_FAILED',
          ]);
      }
    },
  );

  it('reports failed close acknowledgement after a real handle closes successfully', async () => {
    const path = await temporaryPath();
    const acknowledgement = new Error('close acknowledgement lost');

    const exit = await Effect.runPromiseExit(
      withStoreScope((owner) =>
        Effect.gen(function* () {
          const handle = yield* openSqliteHandle(path);
          yield* owner.register(
            storeCall('WRITE_FAILED', 'close failed', async () => {
              await handle.close();
              throw acknowledgement;
            }),
          );
          yield* migrateToLatest(handle);

          return 'schema read';
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit))
      expect(
        exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
      ).toMatchObject([{ code: 'WRITE_FAILED', cause: { primary: { value: 'schema read' } } }]);
  });

  it('captures a release defect as a typed close failure after successful work', async () => {
    const defect = new Error('driver close defect');

    const exit = await Effect.runPromiseExit(
      withStoreScope((owner) =>
        Effect.gen(function* () {
          yield* owner.register(Effect.die(defect));

          return 'read evidence';
        }),
      ),
    );

    expect(Exit.isFailure(exit) && !Cause.hasDies(exit.cause)).toBe(true);

    if (Exit.isFailure(exit)) {
      const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
      expect(errors).toMatchObject([
        { code: 'WRITE_FAILED', cause: { primary: { value: 'read evidence' } } },
      ]);
    }
  });

  it('releases failed initialization and permits a corrected schema to open in the same owner', async () => {
    const path = await temporaryPath();
    const handle = await run(openSqliteHandle(path));
    await run(migrateToLatest(handle));
    await handle.exec("INSERT INTO schema_migrations VALUES (999, 'future', 'now')");
    await run(
      withStoreScope((owner) =>
        Effect.gen(function* () {
          const failed = yield* Effect.exit(openStore(path, owner));
          expect(
            Exit.isFailure(failed) &&
              failed.cause.reasons
                .filter(Cause.isFailReason)
                .some((reason) => reason.error.code === 'SCHEMA_TOO_NEW'),
          ).toBe(true);
          yield* Effect.promise(() =>
            handle.exec('DELETE FROM schema_migrations WHERE version = 999'),
          );
          const store = yield* openStore(path, owner);
          expect((yield* store.runs.listRuns()).items).toEqual([]);
        }),
      ),
    );
    await handle.close();
  });

  it('joins a real Kysely transaction commit before close after interruption', async () => {
    const path = await temporaryPath();
    const started = gate();
    const commit = gate();
    const interrupted = gate();
    const events: string[] = [];

    const result = Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          withStoreScope((owner) =>
            Effect.gen(function* () {
              const handle = yield* openSqliteHandle(path);
              yield* migrateToLatest(handle);

              const database = new Kysely<Database>({
                dialect: createSqliteDialect({
                  ...handle,
                  commit: async () => {
                    events.push('commit started');
                    started.release();
                    await commit.promise;
                    await handle.commit();
                    events.push('committed');
                  },
                  close: async () => {
                    events.push('closed');
                    await handle.close();
                  },
                }),
              });

              yield* owner.register(
                storeCall('WRITE_FAILED', 'close failed', () => database.destroy()),
              );
              const cache = createCacheStore(database, owner);
              // A hit takes the genuine Kysely transaction path, including its commit acknowledgement.
              yield* cache.put('judge', 'hash', { score: 1 });
              yield* cache.get('judge', 'hash');
            }),
          ),
        );

        yield* Effect.promise(() => started.promise);
        fiber.interruptUnsafe();
        interrupted.release();

        return yield* Fiber.await(fiber);
      }),
    );

    await interrupted.promise;
    expect(events).toEqual(['commit started']);
    commit.release();
    const outer = await result;
    expect(
      Exit.isSuccess(outer) &&
        Exit.isFailure(outer.value) &&
        Cause.hasInterrupts(outer.value.cause),
    ).toBe(true);
    expect(events).toEqual(['commit started', 'committed', 'closed']);
    await run(
      withStoreScope((owner) =>
        Effect.gen(function* () {
          const store = yield* openStore(path, owner);
          expect(yield* store.cache.get('judge', 'hash')).toEqual({ score: 1 });
        }),
      ),
    );
  });

  it('waits for detached accepted work and rejects new opens during closure', async () => {
    const started = gate(),
      finish = gate(),
      closing = gate();

    let escaped: StoreScope | undefined;
    const events: string[] = [];

    const result = run(
      withStoreScope((owner) =>
        Effect.gen(function* () {
          escaped = owner;
          yield* owner.register(
            Effect.sync(() => {
              events.push('closed');
            }),
          );
          yield* Effect.forkDetach(
            owner.run(
              Effect.promise(async () => {
                started.release();
                await finish.promise;
                events.push('finished');
              }),
            ),
          );
          yield* Effect.promise(() => started.promise);
          closing.release();
        }),
      ),
    );

    await closing.promise;
    // Let the owner's primary Exit reach its pending-work join.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
    expect(escaped).toBeDefined();

    if (escaped)
      await expect(run(openStore(await temporaryPath(), escaped))).rejects.toMatchObject({
        code: 'READ_FAILED',
      });
    finish.release();
    await result;
    expect(events).toEqual(['finished', 'closed']);
  });
});
