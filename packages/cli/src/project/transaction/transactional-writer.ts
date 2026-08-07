import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { LoadedProject } from '../load-project.js';
import { loadProject } from '../load-project.js';
import { prepareProjectCandidate, type PreparedProjectCandidate } from './candidate-project.js';
import { acquireProjectLock, releaseProjectLock, type ProjectLockHandle } from './project-lock.js';
import { resolveSafeProjectPath } from './project-path.js';
import { ProjectTransactionError } from './project-transaction-error.js';
import { createSemanticProjectDiff } from './semantic-project-diff.js';
import {
  cleanupPreparedTransaction,
  prepareTransaction,
  readByteHash,
  recoverProjectTransactions,
  rollbackPreparedTransaction,
  syncPath,
  writeTransactionJournal,
  type PreparedTransaction,
  type TransactionFileChange,
  type TransactionJournalEntry,
} from './transaction-journal.js';
import type { ProjectMutationRequest, ProjectMutationResult } from './transaction-types.js';

type PublishEvent = {
  entry: TransactionJournalEntry;
  index: number;
  transactionId: string;
};

type PublishObserver = (event: PublishEvent) => Promise<void> | void;

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

const createMissingDirectories = async (
  root: string,
  prepared: PreparedTransaction,
): Promise<void> => {
  for (const path of prepared.journal.created_directories) {
    const absolutePath = join(root, path);
    await mkdir(absolutePath);
    await syncPath(dirname(absolutePath));
  }
};

/** Publishes staged paths by atomic rename, recording progress after every file. */
const publishPreparedTransaction = async (
  root: string,
  prepared: PreparedTransaction,
  observer?: PublishObserver,
): Promise<void> => {
  const manifestIndex = prepared.journal.entries.findIndex(
    ({ path }) => path === prepared.journal.manifest_path,
  );
  if (manifestIndex !== prepared.journal.entries.length - 1) {
    throw new ProjectTransactionError(
      'project_transaction_failed',
      'Transaction manifest is not the final publish entry.',
    );
  }

  prepared.journal.status = 'publishing';
  await writeTransactionJournal(prepared);
  await createMissingDirectories(root, prepared);
  for (const [index, entry] of prepared.journal.entries.entries()) {
    const destination = await resolveSafeProjectPath(root, entry.path);
    if ((await readByteHash(destination)) !== entry.original_hash) {
      throw new ProjectTransactionError(
        'project_recovery_required',
        'Transaction refused to overwrite a path changed after staging.',
        {
          path: entry.path,
          details: { transaction_id: prepared.journal.transaction_id },
        },
      );
    }
    if (entry.type === 'write') {
      if (entry.staged_path === null) {
        throw new ProjectTransactionError(
          'project_transaction_failed',
          'Write entry is missing staged contents.',
          { path: entry.path },
        );
      }
      // Recheck the destination after directory creation to reject symlink swaps.
      await resolveSafeProjectPath(root, entry.path);
      await rename(join(prepared.directory, entry.staged_path), destination);
    } else {
      await unlink(destination);
    }
    await syncPath(dirname(destination));
    prepared.journal.published_count = index + 1;
    await writeTransactionJournal(prepared);
    await observer?.({ entry, index, transactionId: prepared.journal.transaction_id });
  }
};

/** Marks a verified transaction committed before its recoverable artifacts are removed. */
const markTransactionCommitted = async (prepared: PreparedTransaction): Promise<void> => {
  prepared.journal.status = 'committed';
  await writeTransactionJournal(prepared);
};

const loadMutationState = async (
  request: ProjectMutationRequest,
): Promise<{
  after: PreparedProjectCandidate;
  before: LoadedProject;
  result: ProjectMutationResult;
}> => {
  const before = await loadProject({ project: request.projectRoot });
  assertExpectedProjectHash(before.projectHash, request.expectedProjectHash);
  const after = prepareProjectCandidate(request.candidate);
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
};

const rollbackAfterFailure = async (
  root: string,
  prepared: PreparedTransaction,
  failure: unknown,
): Promise<never> => {
  try {
    await rollbackPreparedTransaction(root, prepared);
    await cleanupPreparedTransaction(root, prepared);
  } catch (rollbackFailure: unknown) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Transaction failed and automatic rollback could not complete.',
      {
        details: { transaction_id: prepared.journal.transaction_id },
        cause: rollbackFailure,
      },
    );
  }
  if (failure instanceof ProjectTransactionError) {
    throw failure;
  }
  throw new ProjectTransactionError(
    'project_transaction_failed',
    'Transaction failed; the prior project was restored.',
    {
      details: { transaction_id: prepared.journal.transaction_id },
      cause: failure,
    },
  );
};

/** Applies one complete candidate atomically or returns its identical write-free preview. */
const applyProjectMutation = async (
  request: ProjectMutationRequest,
  options: { publishObserver?: PublishObserver } = {},
): Promise<ProjectMutationResult> => {
  if (request.dryRun === true) {
    // This branch intentionally runs before mkdir, lock acquisition, journal staging, or recovery.
    return (await loadMutationState(request)).result;
  }

  let lock: ProjectLockHandle | undefined;
  try {
    lock = await acquireProjectLock(request.projectRoot);
    await recoverProjectTransactions(request.projectRoot, lock);
    const state = await loadMutationState(request);
    const changes = createFileChanges(state.before, state.after);
    if (changes.length === 0) {
      return { ...state.result, committed: true };
    }

    const prepared = await prepareTransaction(
      request.projectRoot,
      changes,
      state.before.projectHash,
      state.after.projectHash,
    );
    try {
      await publishPreparedTransaction(request.projectRoot, prepared, options.publishObserver);
      const verified = await loadProject({ project: request.projectRoot });
      if (verified.projectHash !== state.after.projectHash) {
        throw new ProjectTransactionError(
          'project_transaction_failed',
          'Published project hash does not match the candidate.',
          { details: { current_hash: verified.projectHash } },
        );
      }
      await markTransactionCommitted(prepared);
      await cleanupPreparedTransaction(request.projectRoot, prepared);
      return {
        ...state.result,
        committed: true,
        transactionId: prepared.journal.transaction_id,
      };
    } catch (failure: unknown) {
      return await rollbackAfterFailure(request.projectRoot, prepared, failure);
    }
  } finally {
    if (lock !== undefined) {
      await releaseProjectLock(lock);
    }
  }
};

export {
  applyProjectMutation,
  createFileChanges,
  markTransactionCommitted,
  publishPreparedTransaction,
  type PublishEvent,
  type PublishObserver,
};
