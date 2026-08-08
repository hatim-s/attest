import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { discoverProject } from '../../project/discover-project.js';
import { loadProject, type LoadedProject } from '../../project/load-project.js';
import {
  acquireProjectLock,
  inspectProjectLock,
  ProjectTransactionError,
  recoverProjectTransactions,
  releaseProjectLock,
  TRANSACTIONS_DIRECTORY,
  type ProjectLockInspection,
} from '../../project/transaction/index.js';

type LoadCommandProjectOptions = {
  project?: string;
  workingDirectory: string;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const throwForReaderLock = (
  inspection: Exclude<ProjectLockInspection, { state: 'absent' }>,
): never => {
  if (inspection.state === 'stale') {
    throw new ProjectTransactionError('project_lock_stale', 'The project lock is stale.', {
      path: '.attest/project.lock',
      hint: 'Preview and explicitly remove the stale lock before retrying.',
      details: { lock_state: inspection.state, reason: inspection.reason },
    });
  }
  throw new ProjectTransactionError(
    inspection.state === 'invalid' ? 'project_recovery_required' : 'project_locked',
    inspection.state === 'invalid'
      ? 'The project lock is malformed and requires recovery.'
      : 'The project is locked by another process.',
    {
      path: '.attest/project.lock',
      details: { lock_state: inspection.state, reason: inspection.reason },
    },
  );
};

/** Detects transaction journals without following a replacement transactions directory. */
const hasRecoveryArtifacts = async (root: string): Promise<boolean> => {
  const path = join(root, TRANSACTIONS_DIRECTORY);
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProjectTransactionError(
        'project_recovery_required',
        'The project transaction directory is not safe to inspect.',
        { path: TRANSACTIONS_DIRECTORY },
      );
    }
    return (await readdir(path)).length > 0;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
};

/** Recovers interrupted journals under the same exclusive boundary used by project writers. */
const recoverBeforeRead = async (root: string): Promise<void> => {
  if (!(await hasRecoveryArtifacts(root))) return;
  const lock = await acquireProjectLock(root);
  let recoveryFailure: unknown;
  try {
    await recoverProjectTransactions(root, lock);
  } catch (error: unknown) {
    recoveryFailure = error;
  }
  try {
    await releaseProjectLock(lock);
  } catch (error: unknown) {
    if (recoveryFailure === undefined) throw error;
  }
  if (recoveryFailure instanceof Error) throw recoveryFailure;
  if (recoveryFailure !== undefined) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Project recovery failed with an invalid error value.',
      { cause: recoveryFailure },
    );
  }
};

/** Loads a hash-verified old or new snapshot while rejecting a concurrent publication window. */
const loadCommandProject = async (options: LoadCommandProjectOptions): Promise<LoadedProject> => {
  const discovered = await discoverProject(options);
  await recoverBeforeRead(discovered.root);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await inspectProjectLock(discovered.root);
    if (before.state !== 'absent') return throwForReaderLock(before);
    try {
      const loaded = await loadProject({
        project: discovered.root,
        workingDirectory: discovered.root,
      });
      const after = await inspectProjectLock(discovered.root);
      if (after.state !== 'absent') return throwForReaderLock(after);
      return loaded;
    } catch (error: unknown) {
      const after = await inspectProjectLock(discovered.root);
      if (after.state !== 'absent') return throwForReaderLock(after);
      // A writer can publish and release entirely between the two lock inspections.
      if (attempt === 2) throw error;
    }
  }
  throw new ProjectTransactionError('project_transaction_failed', 'Could not read the project.');
};

export { loadCommandProject, type LoadCommandProjectOptions };
