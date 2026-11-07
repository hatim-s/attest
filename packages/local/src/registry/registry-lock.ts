import * as Effect from 'effect/Effect';
import { open, rm } from 'node:fs/promises';
import { LocalError } from '../errors/index.js';
import { errnoCode } from '../internal/errno-code.js';
import { createPrivateAncestors } from '../internal/private-file.js';
import { anchoredCall } from '../internal/open-anchored.js';
import { withOperationCleanup } from '../internal/operation-cleanup.js';

/** Creates the exclusive lock and closes its descriptor before publishing ownership. */
const acquireLock = Effect.fn('acquireRegistryLock')(function* (lockPath: string) {
  const deadline = Date.now() + 10_000;

  for (;;) {
    const handle = yield* anchoredCall('open', lockPath, () => open(lockPath, 'wx', 0o600)).pipe(
      Effect.catch((cause) =>
        errnoCode(cause) === 'EEXIST' && Date.now() < deadline
          ? Effect.succeed(undefined)
          : Effect.fail(cause),
      ),
    );

    if (handle !== undefined) {
      return yield* withOperationCleanup(
        Effect.void,
        anchoredCall('close', lockPath, () => handle.close()),
      );
    }

    yield* Effect.sleep(20);
  }
});

/** Serializes accepted registry writes and joins publication before releasing the lock. */
const withRegistryLock = <A, E extends Error, R>(
  registryPath: string,
  update: () => Effect.Effect<A, E, R>,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const lockPath = `${registryPath}.lock`;
      yield* Effect.gen(function* () {
        yield* createPrivateAncestors(lockPath);
        yield* acquireLock(lockPath);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LocalError('registry_write_failed', 'Could not lock the project registry.', {
              path: lockPath,
              hint:
                errnoCode(cause) === 'EEXIST'
                  ? `Another Attest command is updating the registry. If none is running, delete ${lockPath} and retry.`
                  : 'Check that the registry directory is writable and that no parent is a symbolic link, then retry.',
              cause,
            }),
        ),
      );

      return yield* withOperationCleanup(
        Effect.suspend(update),
        anchoredCall('rm', lockPath, () => rm(lockPath, { force: true })),
        'registry_write_failed',
      );
    }),
  );

export { withRegistryLock };
