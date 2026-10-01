import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { ProjectTransactionError } from './project-transaction-error.js';

const PROJECT_LOCK_FILE = '.attest/project.lock';
const PROJECT_LOCK_SCHEMA = 'attest.project-lock';
const execFileAsync = promisify(execFile);

type ProjectLockMetadata = {
  created_at: string;
  hostname: string;
  owner_token: string;
  pid: number;
  process_start_identity: string | null;
  schema: typeof PROJECT_LOCK_SCHEMA;
};

type ProjectLockInspection =
  | { state: 'absent' }
  | { raw: string; reason: string; state: 'invalid' }
  | {
      metadata: ProjectLockMetadata;
      raw: string;
      reason: string;
      state: 'live' | 'stale' | 'unknown';
    };

type ProjectLockHandle = {
  metadata: ProjectLockMetadata;
  path: string;
  root: string;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

/** Fsyncs a directory entry after creating or removing lock metadata. */
const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Reads the kernel-observed start identity used to detect PID reuse on macOS and Linux. */
const getProcessStartIdentity = async (pid: number): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const parseLockMetadata = (raw: string): ProjectLockMetadata | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== PROJECT_LOCK_SCHEMA ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.hostname !== 'string' ||
    typeof record.owner_token !== 'string' ||
    typeof record.created_at !== 'string' ||
    (record.process_start_identity !== null && typeof record.process_start_identity !== 'string')
  ) {
    return undefined;
  }
  return value as ProjectLockMetadata;
};

const isProcessPresent = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM proves the process exists even though this user cannot signal it.
    return getErrorCode(error) === 'EPERM';
  }
};

/** Classifies the project lock without mutating or stealing it. */
const inspectProjectLock = async (root: string): Promise<ProjectLockInspection> => {
  const path = join(root, PROJECT_LOCK_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return { state: 'absent' };
    }
    throw new ProjectTransactionError('project_locked', 'Could not inspect the project lock.', {
      path: PROJECT_LOCK_FILE,
      details: { lock_state: 'unreadable' },
      cause: error,
    });
  }

  const metadata = parseLockMetadata(raw);
  if (metadata === undefined) {
    return { raw, reason: 'lock metadata is malformed', state: 'invalid' };
  }
  if (metadata.hostname !== hostname()) {
    return {
      metadata,
      raw,
      reason: 'lock belongs to another hostname and cannot be proven stale locally',
      state: 'unknown',
    };
  }
  if (!isProcessPresent(metadata.pid)) {
    return { metadata, raw, reason: 'owner process no longer exists', state: 'stale' };
  }
  if (metadata.process_start_identity === null) {
    return {
      metadata,
      raw,
      reason: 'owner PID is live; start identity was unavailable when the lock was created',
      state: 'live',
    };
  }
  const currentIdentity = await getProcessStartIdentity(metadata.pid);
  if (currentIdentity === null) {
    return {
      metadata,
      raw,
      reason: 'owner PID is live; current start identity cannot be inspected',
      state: 'live',
    };
  }
  if (currentIdentity !== metadata.process_start_identity) {
    return { metadata, raw, reason: 'owner PID was reused by another process', state: 'stale' };
  }
  return { metadata, raw, reason: 'owner process and start identity are live', state: 'live' };
};

const throwForExistingLock = (
  inspection: Exclude<ProjectLockInspection, { state: 'absent' }>,
): never => {
  if (inspection.state === 'stale') {
    throw new ProjectTransactionError('project_lock_stale', 'The project lock is stale.', {
      path: PROJECT_LOCK_FILE,
      hint: 'Preview and explicitly remove the stale lock before retrying.',
      details: {
        lock: inspection.metadata,
        lock_state: inspection.state,
        reason: inspection.reason,
      },
    });
  }
  throw new ProjectTransactionError(
    'project_locked',
    inspection.state === 'invalid'
      ? 'The project lock is malformed and cannot be safely classified.'
      : 'The project is locked by another process.',
    {
      path: PROJECT_LOCK_FILE,
      details: {
        lock_state: inspection.state,
        reason: inspection.reason,
        ...(inspection.state === 'invalid' ? {} : { lock: inspection.metadata }),
      },
    },
  );
};

/** Acquires the project-local lock exclusively and never steals an existing owner. */
const acquireProjectLock = async (root: string): Promise<ProjectLockHandle> => {
  const path = join(root, PROJECT_LOCK_FILE);
  await mkdir(dirname(path), { recursive: true });
  const metadata: ProjectLockMetadata = {
    schema: PROJECT_LOCK_SCHEMA,
    owner_token: randomUUID(),
    pid: process.pid,
    process_start_identity: await getProcessStartIdentity(process.pid),
    hostname: hostname(),
    created_at: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'EEXIST') {
      const inspection = await inspectProjectLock(root);
      if (inspection.state === 'absent') {
        // The owner released between open and inspection; a fresh retry is safe.
        return acquireProjectLock(root);
      }
      return throwForExistingLock(inspection);
    }
    throw new ProjectTransactionError(
      'project_transaction_failed',
      'Could not create project lock.',
      {
        path: PROJECT_LOCK_FILE,
        cause: error,
      },
    );
  }
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  return { metadata, path, root };
};

/** Releases a lock only when its on-disk owner token still belongs to this handle. */
const releaseProjectLock = async (lock: ProjectLockHandle): Promise<void> => {
  const inspection = await inspectProjectLock(lock.root);
  if (
    inspection.state === 'absent' ||
    inspection.state === 'invalid' ||
    inspection.metadata.owner_token !== lock.metadata.owner_token
  ) {
    throw new ProjectTransactionError('project_locked', 'Project lock ownership changed.', {
      path: PROJECT_LOCK_FILE,
      details: { lock_state: inspection.state },
    });
  }
  await unlink(lock.path);
  await syncDirectory(dirname(lock.path));
};

/** Previews or explicitly removes a lock proven stale without touching recovery journals. */
const unlockStaleProjectLock = async (
  root: string,
  options: { dryRun?: boolean } = {},
): Promise<ProjectLockMetadata> => {
  const inspection = await inspectProjectLock(root);
  if (inspection.state !== 'stale') {
    if (inspection.state === 'absent') {
      throw new ProjectTransactionError('project_locked', 'The project has no lock to remove.', {
        path: PROJECT_LOCK_FILE,
        details: { lock_state: inspection.state },
      });
    }
    return throwForExistingLock(inspection);
  }
  if (options.dryRun === true) {
    return inspection.metadata;
  }

  // Re-read before unlinking so a replacement owner can never be removed by a stale preview.
  const currentRaw = await readFile(join(root, PROJECT_LOCK_FILE), 'utf8');
  if (currentRaw !== inspection.raw) {
    throw new ProjectTransactionError('project_locked', 'Project lock changed before removal.', {
      path: PROJECT_LOCK_FILE,
      details: { lock_state: 'changed' },
    });
  }
  await unlink(join(root, PROJECT_LOCK_FILE));
  await syncDirectory(join(root, '.attest'));
  return inspection.metadata;
};

export {
  PROJECT_LOCK_FILE,
  PROJECT_LOCK_SCHEMA,
  acquireProjectLock,
  inspectProjectLock,
  releaseProjectLock,
  unlockStaleProjectLock,
  type ProjectLockHandle,
  type ProjectLockInspection,
  type ProjectLockMetadata,
};
