import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import * as Deferred from 'effect/Deferred';
import * as Semaphore from 'effect/Semaphore';
import { StoreError, type AttestStore } from '@attest/core';
import { finishStoreCleanup } from './store-effect.js';

/** Owns store handles and their cleanup receipts for exactly one use operation. */
class StoreScope {
  readonly #scope: Scope.Closeable;
  readonly #idle = Deferred.makeUnsafe<void>();
  readonly #opens = Semaphore.makeUnsafe(1);
  readonly #stores = new Map<string, { mode: 'write' | 'readonly'; store: AttestStore }>();
  #state: 'open' | 'closing' | 'closed' = 'open';
  #pending = 0;
  #cleanup: Exit.Exit<void, StoreError> = Exit.void;

  private constructor(scope: Scope.Closeable) {
    this.#scope = scope;
  }

  /** Masks foreign work and joins it before release, including uncooperative reads. */
  run<A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R> {
    return Effect.uninterruptible(
      Effect.suspend<A, E | StoreError, R>(() => {
        if (this.#state !== 'open')
          return Effect.fail(new StoreError('READ_FAILED', 'Store owner is closed.'));
        this.#pending++;

        return operation.pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              this.#pending--;

              return this.#state === 'closing' && this.#pending === 0
                ? Deferred.succeed(this.#idle, undefined)
                : Effect.void;
            }),
          ),
        );
      }),
    );
  }

  /** Serializes opens and caches only successful acquisitions, with no mode-changing fallback. */
  open(path: string, mode: 'write' | 'readonly', acquire: Effect.Effect<AttestStore, StoreError>) {
    return this.run(
      this.#opens.withPermit(
        Effect.gen({ self: this }, function* () {
          const existing = this.#stores.get(path);

          if (existing) {
            if (existing.mode !== mode)
              return yield* Effect.fail(
                new StoreError('READ_FAILED', 'Store already opened with a different access mode.'),
              );

            return existing.store;
          }

          const store = yield* acquire;
          this.#stores.set(path, { mode, store });

          return store;
        }),
      ),
    );
  }

  /** Records every failed release without letting a finalizer replace the primary Cause. */
  register(release: Effect.Effect<void, StoreError>): Effect.Effect<void, StoreError> {
    return Effect.suspend(() => {
      if (this.#state === 'closed' || (this.#state === 'closing' && this.#pending === 0)) {
        return Effect.fail(new StoreError('READ_FAILED', 'Store owner is closed.'));
      }

      return Scope.addFinalizer(
        this.#scope,
        Effect.gen({ self: this }, function* () {
          const result = yield* Effect.exit(
            release.pipe(
              Effect.catchCause((cause) =>
                Effect.fail(
                  new StoreError('WRITE_FAILED', 'Could not release a store resource.', { cause }),
                ),
              ),
            ),
          );

          if (Exit.isFailure(result)) {
            this.#cleanup = Exit.isFailure(this.#cleanup)
              ? Exit.failCause(Cause.combine(this.#cleanup.cause, result.cause))
              : result;
          }
        }),
      );
    });
  }

  /** Keeps the scope and receipt private, then projects cleanup only after all work joins. */
  static use<A, E, R>(
    this: void,
    use: (owner: StoreScope) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StoreError, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const owner = new StoreScope(yield* Scope.make());
        const primary = yield* Effect.exit(restore(Effect.suspend(() => use(owner))));
        owner.#state = 'closing';

        if (owner.#pending > 0) yield* Deferred.await(owner.#idle);
        yield* Scope.close(owner.#scope, primary);
        owner.#state = 'closed';
        owner.#stores.clear();

        if (Exit.isSuccess(primary) && Exit.isFailure(owner.#cleanup)) {
          return yield* Effect.fail(
            new StoreError('WRITE_FAILED', 'Store work completed but release failed.', {
              cause: { primary, cleanup: owner.#cleanup.cause },
            }),
          );
        }

        return yield* finishStoreCleanup(primary, owner.#cleanup);
      }),
    );
  }
}

const withStoreScope = StoreScope.use;

export { StoreScope, withStoreScope };
