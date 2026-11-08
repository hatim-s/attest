import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Context from 'effect/Context';
import * as Option from 'effect/Option';
import { StoreCleanup } from '../../store/internal/store-effect.js';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import { StoreError } from '@attest/core';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errnoCode } from '../../internal/errno-code.js';
import { anchoredCall } from '../../internal/open-anchored.js';
import { withReadCleanup, runCleanupSteps } from './cleanup.js';

const COPY_BUFFER_BYTES = 64 * 1024;

const MAX_SNAPSHOT_ATTEMPTS = 4;

type FileVersion = BigIntStats;

type RunStoreSnapshot = {
  directory: string;
  path: string;
  release: Effect.Effect<void, StoreError>;
};

/** Marks a source version change during capture; only this failure allows another attempt. */
class SnapshotChangedError extends Data.TaggedError('SnapshotChangedError') {
  override readonly message = 'Run store changed while its read snapshot was captured.';
}

const sameIdentity = (left: FileVersion, right: FileVersion): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameVersion = (left: FileVersion, right: FileVersion): boolean =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

/** Wraps individual filesystem calls; their rejections are store read failures. */
const fileCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new StoreError('READ_FAILED', 'Could not capture the run store snapshot.', { cause }),
  });

/** Copies an exact descriptor version without reopening its source pathname. */
const copyFileHandle = Effect.fn('copyFileHandle')(function* (
  source: FileHandle,
  destination: string,
  expectedSizeValue: bigint,
) {
  if (expectedSizeValue > BigInt(Number.MAX_SAFE_INTEGER))
    return yield* Effect.fail(new SnapshotChangedError());
  const expectedSize = Number(expectedSizeValue);
  const target = yield* fileCall(() => open(destination, 'wx', 0o600));

  return yield* withReadCleanup(
    Effect.gen(function* () {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let offset = 0;

      while (offset < expectedSize) {
        const length = Math.min(buffer.length, expectedSize - offset);
        const { bytesRead } = yield* fileCall(() => source.read(buffer, 0, length, offset));

        if (bytesRead === 0) return yield* Effect.fail(new SnapshotChangedError());
        let written = 0;

        while (written < bytesRead) {
          const result = yield* fileCall(() =>
            target.write(buffer, written, bytesRead - written, offset + written),
          );

          if (result.bytesWritten === 0) return yield* Effect.fail(new SnapshotChangedError());
          written += result.bytesWritten;
        }

        offset += bytesRead;
      }
    }),
    () => [fileCall(() => target.close())],
  );
});

/** Missing WAL is distinct from inaccessible or unsafe WAL. */
const statOptional = (path: string) =>
  anchoredCall('lstat', path, () => lstat(path, { bigint: true })).pipe(
    Effect.catch((failure) =>
      failure.code === 'ENOENT'
        ? Effect.succeed(undefined)
        : Effect.fail(
            new StoreError('READ_FAILED', 'Could not inspect snapshot source.', {
              cause: failure.cause,
            }),
          ),
    ),
  );

/** Opens and fences the WAL before transferring its descriptor to the snapshot attempt. */
const openWal = Effect.fn('openWal')(function* (path: string) {
  const metadata = yield* statOptional(path);

  if (metadata === undefined) return undefined;

  if (!metadata.isFile() || metadata.isSymbolicLink())
    return yield* Effect.fail(new SnapshotChangedError());

  const handle = yield* Effect.tryPromise({
    try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    catch: (cause) =>
      errnoCode(cause) === 'ENOENT'
        ? new SnapshotChangedError()
        : new StoreError('READ_FAILED', 'Could not open WAL descriptor.', { cause }),
  });

  let transferred = false;

  return yield* withReadCleanup(
    Effect.gen(function* () {
      const version = yield* fileCall(() => handle.stat({ bigint: true }));
      const current = yield* statOptional(path);

      if (
        current === undefined ||
        !sameIdentity(metadata, version) ||
        !sameIdentity(version, current)
      )
        return yield* Effect.fail(new SnapshotChangedError());
      transferred = true;

      return { handle, version };
    }),
    () => (transferred ? [] : [fileCall(() => handle.close())]),
  );
});

const pathMatchesVersion = Effect.fn('pathMatchesVersion')(function* (
  path: string,
  version: FileVersion,
) {
  const current = yield* statOptional(path);

  return current !== undefined && !current.isSymbolicLink() && sameIdentity(current, version);
});

/** Captures a stable main/WAL pair. Failed cleanup forbids version-change retries. */
const captureAttempt = Effect.fn('captureAttempt')(function* (
  sourcePath: string,
  source: FileHandle,
) {
  const directory = yield* fileCall(() => mkdtemp(join(tmpdir(), 'attest-run-store-snapshot-')));

  const snapshot: RunStoreSnapshot = {
    directory,
    path: join(directory, 'runs.db'),
    release: Effect.void,
  };

  const walPath = `${sourcePath}-wal`;
  let wal: Effect.Success<ReturnType<typeof openWal>>;
  let transferred = false;

  return yield* withReadCleanup(
    Effect.gen(function* () {
      const sourceBefore = yield* fileCall(() => source.stat({ bigint: true }));

      if (!(yield* pathMatchesVersion(sourcePath, sourceBefore)))
        return yield* Effect.fail(new SnapshotChangedError());
      wal = yield* openWal(walPath);
      yield* copyFileHandle(source, snapshot.path, sourceBefore.size);

      if (wal !== undefined)
        yield* copyFileHandle(wal.handle, `${snapshot.path}-wal`, wal.version.size);
      const sourceAfter = yield* fileCall(() => source.stat({ bigint: true }));

      if (
        !sameVersion(sourceBefore, sourceAfter) ||
        !(yield* pathMatchesVersion(sourcePath, sourceAfter))
      )
        return yield* Effect.fail(new SnapshotChangedError());

      if (wal === undefined) {
        if ((yield* statOptional(walPath)) !== undefined)
          return yield* Effect.fail(new SnapshotChangedError());
      } else {
        const currentWal = wal;
        const walAfter = yield* fileCall(() => currentWal.handle.stat({ bigint: true }));

        if (!sameVersion(wal.version, walAfter) || !(yield* pathMatchesVersion(walPath, walAfter)))
          return yield* Effect.fail(new SnapshotChangedError());
        const openedWal = wal;
        snapshot.release = Effect.tryPromise({
          try: () => openedWal.handle.close(),
          catch: (cause) =>
            new StoreError('READ_FAILED', 'Could not close WAL descriptor.', { cause }),
        });
      }

      transferred = true;

      return snapshot;
    }),
    () => [
      ...(wal === undefined || transferred ? [] : [fileCall(() => wal!.handle.close())]),
      ...(transferred ? [] : [removeRunStoreSnapshot(snapshot)]),
    ],
  );
});

/** Retries only clean version changes, retaining annotated cleanup uncertainty as a failure. */
const captureRunStoreSnapshot = Effect.fn('captureRunStoreSnapshot')(function* (
  sourcePath: string,
  source: FileHandle,
) {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
    const result = yield* Effect.exit(captureAttempt(sourcePath, source));

    if (Exit.isSuccess(result)) return result.value;

    const cleanChange =
      !Cause.hasDies(result.cause) &&
      !Cause.hasInterrupts(result.cause) &&
      Option.isNone(Context.getOption(Cause.annotations(result.cause), StoreCleanup)) &&
      result.cause.reasons.every(
        (reason) => Cause.isFailReason(reason) && reason.error instanceof SnapshotChangedError,
      );

    if (!cleanChange || attempt === MAX_SNAPSHOT_ATTEMPTS - 1)
      return yield* Effect.failCause(result.cause);
  }

  return yield* Effect.fail(new SnapshotChangedError());
});

/** Removes copied data only after the database owner's reads and close have settled. */
const removeRunStoreSnapshot = (snapshot: RunStoreSnapshot) =>
  runCleanupSteps([
    fileCall(() => rm(snapshot.directory, { force: true, recursive: true })),
    snapshot.release,
  ]);

export { captureRunStoreSnapshot, removeRunStoreSnapshot, type RunStoreSnapshot };
