import { anchoredCall } from '../../internal/open-anchored.js';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalError } from '../../errors/index.js';
import { syncPath } from '../../internal/sync-path.js';
import type { LoadedProject } from '../project-loader/index.js';
import { loadProject } from '../project-loader/index.js';
import { prepareProjectCandidate, type PreparedProjectCandidate } from './candidate-project.js';
import { withProjectLock, annotateProjectCleanup } from './project-lock.js';
import { resolveSafeProjectPath } from './project-path.js';
import { ProjectTransactionError } from './project-transaction-error.js';
import { createSemanticProjectDiff } from './semantic-project-diff.js';
import {
  cleanupPreparedTransaction,
  completePreparedTransaction,
  prepareTransaction,
  readByteHash,
  recoverProjectTransactions,
  rollbackPreparedTransaction,
  writeTransactionJournal,
  type PreparedTransaction,
  type TransactionFileChange,
} from './transaction-journal.js';
import type { ProjectMutationRequest } from './transaction-types.js';

type ProjectCommitEvidence = { committed: boolean; transaction_id?: string };

const currentFileHashes = (project: LoadedProject): ReadonlyMap<string, string> => {
  const hashes = new Map<string, string>([['attest.project.json', project.contentHashes.manifest]]);
  project.project.resources.agents.forEach(({ id, path }) =>
    hashes.set(path, project.contentHashes.agents[id]!),
  );
  project.project.resources.tests.forEach(({ id, path }) =>
    hashes.set(path, project.contentHashes.tests[id]!),
  );
  project.project.resources.metrics.forEach(({ id, path }) =>
    hashes.set(path, project.contentHashes.metrics[id]!),
  );
  project.project.resources.datasets.forEach(({ data_path, id, metadata_path }) => {
    hashes.set(data_path, project.contentHashes.datasets[id]!.data);
    hashes.set(metadata_path, project.contentHashes.datasets[id]!.metadata);
  });

  return hashes;
};

/** Selects only semantic content changes and always keeps the manifest commit point last. */
const createFileChanges = (
  before: LoadedProject,
  after: PreparedProjectCandidate,
): TransactionFileChange[] => {
  const oldHashes = currentFileHashes(before);
  const changes: TransactionFileChange[] = [];

  for (const [path, file] of after.files) {
    if (oldHashes.get(path) !== file.canonicalHash) {
      changes.push({ contents: file.contents, path, type: 'write' });
    }
  }

  for (const path of oldHashes.keys()) {
    if (!after.files.has(path)) {
      changes.push({ path, type: 'remove' });
    }
  }

  return changes.sort((left, right) => {
    if (left.path === 'attest.project.json') {
      return 1;
    }

    if (right.path === 'attest.project.json') {
      return -1;
    }

    return left.path.localeCompare(right.path);
  });
};

const assertExpectedProjectHash = (actual: string, expected?: string): void => {
  if (expected !== undefined && expected !== actual) {
    throw new ProjectTransactionError('project_changed', 'The project changed after it was read.', {
      hint: 'Read the current project hash, rebuild the candidate, and retry.',
      details: { current_hash: actual, expected_hash: expected },
    });
  }
};

/** Creates the journaled authored parents and fsyncs each parent entry. */
const createMissingDirectories = Effect.fn('createMissingDirectories')(function* (
  root: string,
  prepared: PreparedTransaction,
) {
  for (const path of prepared.journal.created_directories) {
    const absolutePath = join(root, path);
    yield* anchoredCall('mkdir', absolutePath, () => mkdir(absolutePath));
    yield* syncPath(dirname(absolutePath));
  }
}, Effect.uninterruptible);

/** Publishes staged paths by atomic rename with the manifest commit point last. */
const publishPreparedTransaction = Effect.fn('publishPreparedTransaction')(function* (
  root: string,
  prepared: PreparedTransaction,
) {
  const manifestIndex = prepared.journal.entries.findIndex(
    ({ path }) => path === prepared.journal.manifest_path,
  );

  if (manifestIndex !== prepared.journal.entries.length - 1) {
    return yield* Effect.fail(
      new ProjectTransactionError(
        'project_transaction_failed',
        'Transaction manifest is not the final publish entry.',
      ),
    );
  }

  prepared.journal = { ...prepared.journal, status: 'publishing' };
  yield* writeTransactionJournal(prepared);
  yield* createMissingDirectories(root, prepared);

  for (const entry of prepared.journal.entries) {
    const destination = yield* resolveSafeProjectPath(root, entry.path);

    if ((yield* readByteHash(destination)) !== entry.original_hash) {
      return yield* Effect.fail(
        new ProjectTransactionError(
          'project_recovery_required',
          'Transaction refused to overwrite a path changed after staging.',
          {
            path: entry.path,
            details: { transaction_id: prepared.journal.transaction_id },
          },
        ),
      );
    }

    if (entry.type === 'write') {
      // Recheck the destination after directory creation to reject symlink swaps.
      yield* resolveSafeProjectPath(root, entry.path);
      yield* anchoredCall('rename', destination, () =>
        rename(join(prepared.directory, entry.staged_path), destination),
      );
    } else {
      yield* anchoredCall('unlink', destination, () => unlink(destination));
    }

    yield* syncPath(dirname(destination));
  }
}, Effect.uninterruptible);

/** Marks a verified transaction committed before its recoverable artifacts are removed. */
const markTransactionCommitted = Effect.fn('markTransactionCommitted')(function* (
  prepared: PreparedTransaction,
) {
  prepared.journal = { ...prepared.journal, status: 'committed' };
  yield* writeTransactionJournal(prepared);
}, Effect.uninterruptible);

/** Loads the guarded snapshot and computes a synchronous candidate and semantic diff. */
const loadMutationState = Effect.fn('loadMutationState')(function* (
  request: ProjectMutationRequest,
) {
  const before = yield* loadProject({ project: request.projectRoot });
  yield* Effect.try({
    try: () => assertExpectedProjectHash(before.projectHash, request.expectedProjectHash),
    catch: (cause) =>
      cause instanceof LocalError
        ? cause
        : new ProjectTransactionError('project_invalid', 'Invalid project hash.', { cause }),
  });

  const after = yield* Effect.try({
    try: () => prepareProjectCandidate(request.candidate),
    catch: (cause) =>
      cause instanceof LocalError
        ? cause
        : new ProjectTransactionError('project_invalid', 'Invalid candidate project.', { cause }),
  });

  const diff = createSemanticProjectDiff(before, after.project, {
    renames: request.renames,
    warnings: request.warnings,
  });

  return {
    after,
    before,
    result: {
      committed: false,
      diff,
      projectHashAfter: after.projectHash,
      projectHashBefore: before.projectHash,
    },
  };
}, Effect.uninterruptible);

/** Rolls back a failed publication while retaining its primary Cause and cleanup uncertainty. */
const runPreparedTransaction = Effect.fn('runPreparedTransaction')(function* <
  E extends Error,
  E2 extends Error,
>(options: {
  root: string;
  prepared: PreparedTransaction;
  verify: () => Effect.Effect<unknown, E>;
  beforePublish?: () => Effect.Effect<unknown, E2>;
}) {
  const { root, prepared } = options;

  const primary = yield* Effect.exit(
    Effect.gen(function* () {
      if (options.beforePublish) yield* Effect.suspend(options.beforePublish);
      yield* publishPreparedTransaction(root, prepared);
      yield* Effect.suspend(options.verify);
      yield* markTransactionCommitted(prepared);
    }),
  );

  if (Exit.isFailure(primary)) {
    // Interrupting observation is never evidence that foreign publication rolled back.
    if (Cause.hasInterrupts(primary.cause)) return yield* Effect.failCause(primary.cause);

    const compensation = yield* Effect.exit(
      Effect.gen(function* () {
        yield* rollbackPreparedTransaction(root, prepared);
        yield* cleanupPreparedTransaction(root, prepared);
      }),
    );

    // Compensation determines whether another mutation is safe. Preserve the original Cause
    // as evidence, but report recovery-required when durable rollback cannot be confirmed.
    if (Exit.isFailure(compensation)) {
      const cause = Cause.hasDies(primary.cause)
        ? primary.cause
        : Cause.map(
            primary.cause,
            () =>
              new ProjectTransactionError(
                'project_recovery_required',
                'Transaction failed and automatic rollback could not complete.',
                {
                  details: { transaction_id: prepared.journal.transaction_id },
                  cause: primary.cause,
                },
              ),
          );

      return yield* Effect.failCause(annotateProjectCleanup(cause, compensation.cause));
    }

    if (Cause.hasDies(primary.cause)) return yield* Effect.failCause(primary.cause);

    return yield* Effect.failCause(
      Cause.map(primary.cause, (cause) =>
        cause instanceof LocalError
          ? cause
          : new ProjectTransactionError(
              'project_transaction_failed',
              'Transaction failed; the prior project was restored.',
              { details: { transaction_id: prepared.journal.transaction_id }, cause },
            ),
      ),
    );
  }

  const cleanup = yield* Effect.exit(
    Effect.gen(function* () {
      yield* completePreparedTransaction(root, prepared);
      yield* cleanupPreparedTransaction(root, prepared);
    }),
  );

  if (Exit.isFailure(cleanup))
    return yield* Effect.fail(
      new ProjectTransactionError(
        'project_saved_cleanup_failed',
        'Project change was saved, but Attest could not finish the transaction.',
        {
          details: { committed: true, transaction_id: prepared.journal.transaction_id },
          hint: 'Run attest project validate in this project to finish cleanup. Do not repeat the mutation.',
          cause: cleanup.cause,
        },
      ),
    );
}, Effect.uninterruptible);

/** Applies one complete candidate or returns its write-free preview before lock acquisition. */
const applyProjectMutation = Effect.fn('applyProjectMutation')(function* (
  request: ProjectMutationRequest,
) {
  if (request.dryRun === true) return (yield* loadMutationState(request)).result;

  return yield* withProjectLock(
    request.projectRoot,
    (lock) =>
      Effect.gen(function* () {
        yield* recoverProjectTransactions(request.projectRoot, lock);
        const state = yield* loadMutationState(request);
        const changes = createFileChanges(state.before, state.after);

        if (changes.length === 0) return { ...state.result, committed: true };
        const prepared = yield* prepareTransaction(request.projectRoot, changes);
        yield* runPreparedTransaction({
          root: request.projectRoot,
          prepared,
          verify: () =>
            Effect.gen(function* () {
              const verified = yield* loadProject({ project: request.projectRoot });

              if (verified.projectHash !== state.after.projectHash)
                return yield* Effect.fail(
                  new ProjectTransactionError(
                    'project_transaction_failed',
                    'Published project hash does not match the candidate.',
                    { details: { current_hash: verified.projectHash } },
                  ),
                );
            }),
        });

        return { ...state.result, committed: true, transactionId: prepared.journal.transaction_id };
      }),
    (value) => {
      const details: ProjectCommitEvidence = { committed: value.committed };

      if ('transactionId' in value && value.transactionId)
        details.transaction_id = value.transactionId;

      return details;
    },
  );
}, Effect.uninterruptible);

export {
  applyProjectMutation,
  createFileChanges,
  publishPreparedTransaction,
  runPreparedTransaction,
};
