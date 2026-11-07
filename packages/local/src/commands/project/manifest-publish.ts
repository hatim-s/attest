import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { randomUUID } from 'node:crypto';
import fs, { link, open, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalError } from '../../errors/index.js';
import { anchoredCall, AnchoredFileFailure } from '../../internal/open-anchored.js';
import { syncPath } from '../../internal/sync-path.js';
import { CommandCleanup } from '../shared/command-cleanup.js';

/** Publishes one manifest without overwriting a competing initializer and reconciles failed writes. */
const publishProjectManifest = Effect.fn('publishProjectManifest')(function* (
  root: string,
  contents: string,
) {
  const manifestPath = join(root, 'attest.project.json');
  const temporaryPath = join(root, `.attest-project-${randomUUID()}.tmp`);
  let temporary: FileHandle | undefined;
  let directory: FileHandle | undefined;
  let temporaryExists = false;
  let published = false;

  const primary = yield* Effect.exit(
    Effect.gen(function* () {
      temporary = yield* anchoredCall('open', temporaryPath, () =>
        open(temporaryPath, 'wx', 0o644),
      );
      temporaryExists = true;
      const handle = temporary;
      yield* anchoredCall('writeFile', temporaryPath, () => handle.writeFile(contents, 'utf8'));
      yield* anchoredCall('fsync', temporaryPath, () => handle.sync());
      yield* anchoredCall('close', temporaryPath, () => handle.close());
      temporary = undefined;
      // The hard link is the no-overwrite publication fence.
      yield* anchoredCall('link', manifestPath, () => link(temporaryPath, manifestPath));
      published = true;
      yield* anchoredCall('unlink', temporaryPath, () => fs.unlink(temporaryPath));
      temporaryExists = false;
      directory = yield* anchoredCall('open', root, () => open(root, 'r'));
      const parent = directory;
      yield* anchoredCall('fsync', root, () => parent.sync());
      yield* anchoredCall('close', root, () => parent.close());
      directory = undefined;
    }),
  );

  if (Exit.isSuccess(primary)) return;
  const cleanup: Cause.Cause<unknown>[] = [];

  for (const [path, handle] of [
    [root, directory],
    [temporaryPath, temporary],
  ] as const) {
    if (handle === undefined) continue;
    const closed = yield* Effect.exit(anchoredCall('close', path, () => handle.close()));

    if (Exit.isFailure(closed)) cleanup.push(closed.cause);
  }

  const remove = (path: string) =>
    anchoredCall('unlink', path, () => fs.unlink(path)).pipe(
      Effect.catch((error) =>
        error instanceof AnchoredFileFailure && error.code === 'ENOENT'
          ? Effect.void
          : Effect.fail(error),
      ),
    );

  if (temporaryExists) {
    const removed = yield* Effect.exit(remove(temporaryPath));

    if (Exit.isFailure(removed)) cleanup.push(removed.cause);
  }

  if (published) {
    // Recheck the published bytes before compensating so another writer keeps its manifest.
    const rollback = yield* Effect.exit(rollbackPublishedManifest(root, contents));

    if (Exit.isFailure(rollback)) cleanup.push(rollback.cause);
  }

  const cause =
    cleanup.length === 0
      ? primary.cause
      : Cause.annotate(primary.cause, Context.make(CommandCleanup, cleanup));

  if (Cause.hasDies(cause) || Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);

  if (cleanup.length > 0)
    return yield* Effect.fail(
      new LocalError(
        'project_recovery_required',
        'Initialization failed and temporary publication state could not be removed.',
        {
          path: manifestPath,
          hint: 'Preserve the target directory and reconcile its manifest and temporary files.',
          cause: { primary: cause, cleanup },
        },
      ),
    );

  if (cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error.code === 'EEXIST'))
    return yield* Effect.fail(
      new LocalError('init_conflict', 'Another process initialized this project first.', {
        path: manifestPath,
        hint: 'Inspect the existing project before retrying.',
        cause,
      }),
    );

  return yield* Effect.failCause(cause);
}, Effect.uninterruptible);

/** Removes only the exact manifest published by this initialization attempt. */
const rollbackPublishedManifest = Effect.fn('rollbackPublishedManifest')(function* (
  root: string,
  expectedContents: string,
) {
  const manifestPath = join(root, 'attest.project.json');

  return yield* Effect.gen(function* () {
    const contents = yield* anchoredCall('readFile', manifestPath, () =>
      readFile(manifestPath, 'utf8'),
    );

    if (contents !== expectedContents)
      return yield* Effect.fail(
        new LocalError(
          'project_recovery_required',
          'The published manifest changed before initialization rollback.',
          { path: manifestPath },
        ),
      );
    yield* anchoredCall('unlink', manifestPath, () => fs.unlink(manifestPath));
    yield* syncPath(root);
  }).pipe(
    Effect.catch((error) =>
      error instanceof AnchoredFileFailure && error.code === 'ENOENT'
        ? Effect.void
        : Effect.fail(error),
    ),
  );
}, Effect.uninterruptible);

export { publishProjectManifest, rollbackPublishedManifest };
