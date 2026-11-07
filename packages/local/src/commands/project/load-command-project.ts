import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectResources } from '@attest/contracts';
import {
  anchoredCall,
  AnchoredCleanup,
  AnchoredCleanupFailure,
} from '../../internal/open-anchored.js';
import { discoverProject } from '../../project/discover-project.js';
import { loadProject, type LoadedProject } from '../../project/project-loader/index.js';
import {
  inspectProjectLock,
  withProjectLock,
  throwForExistingLock,
} from '../../project/transaction/project-lock.js';
import {
  ProjectTransactionError,
  recoverProjectTransactions,
  TRANSACTIONS_DIRECTORY,
} from '../../project/transaction/index.js';

const MAX_READ_ATTEMPTS = 3;

type LoadCommandProjectOptions = { project?: string; recover?: boolean; workingDirectory: string };

/** Inspects recovery residue without following a symlinked transaction directory. */
const hasRecoveryArtifacts = Effect.fn('hasRecoveryArtifacts')(function* (root: string) {
  const path = join(root, TRANSACTIONS_DIRECTORY);

  return yield* Effect.gen(function* () {
    const metadata = yield* anchoredCall('lstat', path, () => lstat(path));

    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      return yield* Effect.fail(
        new ProjectTransactionError(
          'project_recovery_required',
          'The project transaction directory is not safe to inspect.',
          { path: TRANSACTIONS_DIRECTORY },
        ),
      );

    return (yield* anchoredCall('readdir', path, () => readdir(path))).length > 0;
  }).pipe(
    Effect.catch((error) => (error.code === 'ENOENT' ? Effect.succeed(false) : Effect.fail(error))),
  );
});

/** Converts the existing synchronous lock classifier into its typed operational failure. */
const rejectLock = (
  inspection: Exclude<Effect.Success<ReturnType<typeof inspectProjectLock>>, { state: 'absent' }>,
) =>
  Effect.try({
    try: () => throwForExistingLock(inspection),
    catch: (cause) =>
      cause instanceof ProjectTransactionError
        ? cause
        : new ProjectTransactionError('project_locked', 'Could not classify project lock.', {
            cause,
          }),
  });

/** Loads a verified snapshot; retries reads only, never recovery or mutation. */
const loadCommandProject = Effect.fn('loadCommandProject')(function* (
  options: LoadCommandProjectOptions,
) {
  const discovered = yield* discoverProject(options);

  if (yield* hasRecoveryArtifacts(discovered.root)) {
    if (options.recover === false)
      return yield* Effect.fail(
        new ProjectTransactionError(
          'project_recovery_required',
          'The project has an interrupted transaction that requires recovery.',
          {
            path: TRANSACTIONS_DIRECTORY,
            hint: 'Run a non-dry-run project command to recover before previewing changes.',
          },
        ),
      );
    yield* withProjectLock(discovered.root, (lock) =>
      recoverProjectTransactions(discovered.root, lock),
    );
  }

  for (let attempt = 1; ; attempt += 1) {
    const before = yield* inspectProjectLock(discovered.root);

    if (before.state !== 'absent') return yield* rejectLock(before);

    const loaded = yield* Effect.exit(
      loadProject({ project: discovered.root, workingDirectory: discovered.root }),
    );

    if (Exit.isFailure(loaded)) {
      const cleanup = Context.getOrUndefined(Cause.annotations(loaded.cause), AnchoredCleanup);

      const failedClose = loaded.cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && reason.error instanceof AnchoredCleanupFailure,
      );

      // A later writer cannot replace a crashed read or unconfirmed descriptor cleanup.
      if (
        cleanup !== undefined ||
        failedClose ||
        Cause.hasDies(loaded.cause) ||
        Cause.hasInterrupts(loaded.cause)
      )
        return yield* Effect.failCause(loaded.cause);
    }

    const after = yield* inspectProjectLock(discovered.root);

    if (after.state !== 'absent') return yield* rejectLock(after);

    if (Exit.isSuccess(loaded)) return loaded.value;

    if (attempt === MAX_READ_ATTEMPTS) return yield* Effect.failCause(loaded.cause);
  }
});

/**
 * Copies the authored resources out of a loaded project into a candidate that a command can
 * mutate freely; loader-only fields such as hashes and the root stay behind.
 */
const candidateFromLoadedProject = (loaded: LoadedProject): ProjectResources =>
  structuredClone({
    agents: loaded.agents,
    datasets: loaded.datasets,
    metrics: loaded.metrics,
    project: loaded.project,
    tests: loaded.tests,
  });

export { candidateFromLoadedProject, loadCommandProject };
