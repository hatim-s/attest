import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { z } from 'zod';

import { errnoCode } from '../../internal/errno-code.js';
import { syncPath } from '../../internal/sync-path.js';
import type { ProjectLockHandle } from './project-lock.js';
import { resolveSafeProjectPath } from './project-path.js';
import { ProjectTransactionError } from './project-transaction-error.js';

const TRANSACTIONS_DIRECTORY = '.attest/transactions';
const TRANSACTION_JOURNAL_SCHEMA = 'attest.project-transaction';
const JOURNAL_FILE = 'journal.json';

type TransactionFileChange = {
  contents?: string;
  path: string;
  type: 'remove' | 'write';
};

const transactionJournalEntrySchema = z.object({
  backup_path: z.string().nullable(),
  next_hash: z.string().nullable(),
  original_hash: z.string().nullable(),
  path: z.string(),
  staged_path: z.string().nullable(),
  type: z.enum(['remove', 'write']),
});

/** The recovery journal written beside staged files; recovery trusts nothing it does not parse. */
const transactionJournalSchema = z.object({
  created_at: z.string(),
  created_directories: z.array(z.string()),
  entries: z.array(transactionJournalEntrySchema),
  manifest_path: z.literal('attest.project.json'),
  project_hash_after: z.string(),
  project_hash_before: z.string(),
  published_count: z.number().int().nonnegative(),
  schema: z.literal(TRANSACTION_JOURNAL_SCHEMA),
  status: z.enum(['committed', 'prepared', 'publishing', 'rolled_back', 'rolling_back']),
  transaction_id: z.string(),
});

type TransactionJournalEntry = z.infer<typeof transactionJournalEntrySchema>;

type TransactionJournal = z.infer<typeof transactionJournalSchema>;

type PreparedTransaction = {
  directory: string;
  journal: TransactionJournal;
  journalPath: string;
};

type RecoveryResult = {
  action: 'completed_commit' | 'rolled_back';
  transactionId: string;
};

const hashBytes = (contents: string | Buffer): string =>
  createHash('sha256').update(contents).digest('hex');

const readByteHash = async (path: string): Promise<string | null> => {
  try {
    return hashBytes(await readFile(path));
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const syncWrittenFile = async (path: string): Promise<void> => {
  await syncPath(path);
  await syncPath(dirname(path));
};

/** Writes the recovery journal atomically so every visible version is complete JSON. */
const writeTransactionJournal = async (prepared: PreparedTransaction): Promise<void> => {
  const temporaryPath = join(prepared.directory, `.journal-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(prepared.journal)}\n`, { mode: 0o600 });
  await syncPath(temporaryPath);
  await rename(temporaryPath, prepared.journalPath);
  await syncPath(prepared.directory);
};

const missingParentDirectories = async (
  root: string,
  paths: readonly string[],
): Promise<string[]> => {
  const missing = new Set<string>();
  for (const path of paths) {
    const segments = dirname(path)
      .split('/')
      .filter((segment) => segment !== '.');
    let current = '';
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      try {
        const metadata = await lstat(join(root, current));
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new ProjectTransactionError(
            'project_invalid',
            'Transaction directory path is unsafe.',
            { path: current },
          );
        }
      } catch (error: unknown) {
        if (errnoCode(error) !== 'ENOENT') {
          throw error;
        }
        missing.add(current);
      }
    }
  }
  return [...missing].sort((left, right) => left.split('/').length - right.split('/').length);
};

/** Stages complete new contents, exact backups, and a durable pre-publish journal. */
const prepareTransaction = async (
  root: string,
  changes: readonly TransactionFileChange[],
  projectHashBefore: string,
  projectHashAfter: string,
): Promise<PreparedTransaction> => {
  const transactionId = randomUUID();
  const directory = join(root, TRANSACTIONS_DIRECTORY, transactionId);
  const stagedDirectory = join(directory, 'staged');
  const backupDirectory = join(directory, 'backups');
  await mkdir(stagedDirectory, { recursive: true });
  await mkdir(backupDirectory, { recursive: true });

  const entries: TransactionJournalEntry[] = [];
  for (const [index, change] of changes.entries()) {
    const destination = await resolveSafeProjectPath(root, change.path);
    const originalHash = await readByteHash(destination);
    const backupPath = originalHash === null ? null : `backups/${index}`;
    if (backupPath !== null) {
      const absoluteBackup = join(directory, backupPath);
      await copyFile(destination, absoluteBackup);
      await syncWrittenFile(absoluteBackup);
    }

    const stagedPath = change.type === 'write' ? `staged/${index}` : null;
    const nextHash = change.type === 'write' ? hashBytes(change.contents ?? '') : null;
    if (stagedPath !== null) {
      const absoluteStage = join(directory, stagedPath);
      await writeFile(absoluteStage, change.contents ?? '', { mode: 0o644 });
      await syncWrittenFile(absoluteStage);
    }
    entries.push({
      backup_path: backupPath,
      next_hash: nextHash,
      original_hash: originalHash,
      path: change.path,
      staged_path: stagedPath,
      type: change.type,
    });
  }

  const journal: TransactionJournal = {
    schema: TRANSACTION_JOURNAL_SCHEMA,
    transaction_id: transactionId,
    created_at: new Date().toISOString(),
    status: 'prepared',
    manifest_path: 'attest.project.json',
    project_hash_before: projectHashBefore,
    project_hash_after: projectHashAfter,
    published_count: 0,
    created_directories: await missingParentDirectories(
      root,
      changes.filter(({ type }) => type === 'write').map(({ path }) => path),
    ),
    entries,
  };
  const prepared = { directory, journal, journalPath: join(directory, JOURNAL_FILE) };
  await writeTransactionJournal(prepared);
  await syncPath(join(root, TRANSACTIONS_DIRECTORY));
  return prepared;
};

const parseTransactionJournal = (raw: string, directory: string): TransactionJournal => {
  const path = relative(dirname(dirname(directory)), directory);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    value = undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Transaction journal is malformed.',
      { path },
    );
  }
  const parsed = transactionJournalSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Transaction journal has an unsupported shape.',
      { path },
    );
  }
  return parsed.data;
};

/** Loads a transaction journal while keeping every recovery artifact in place on failure. */
const readPreparedTransaction = async (directory: string): Promise<PreparedTransaction> => {
  const journalPath = join(directory, JOURNAL_FILE);
  let raw: string;
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch (error: unknown) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Transaction directory is missing a readable journal.',
      { path: journalPath, cause: error },
    );
  }
  return { directory, journal: parseTransactionJournal(raw, directory), journalPath };
};

const ensureExpectedState = async (
  root: string,
  prepared: PreparedTransaction,
  expected: 'next' | 'original',
): Promise<void> => {
  for (const entry of prepared.journal.entries) {
    const destination = await resolveSafeProjectPath(root, entry.path);
    const expectedHash = expected === 'next' ? entry.next_hash : entry.original_hash;
    if ((await readByteHash(destination)) !== expectedHash) {
      throw new ProjectTransactionError(
        'project_recovery_required',
        'Project path diverged from the recovery journal.',
        {
          path: entry.path,
          details: {
            expected_state: expected,
            transaction_id: prepared.journal.transaction_id,
          },
        },
      );
    }
  }
};

const removeCreatedDirectories = async (root: string, paths: readonly string[]): Promise<void> => {
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(join(root, path));
    } catch (error: unknown) {
      // A non-empty directory now contains authored data and must always be preserved.
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errnoCode(error) ?? '')) {
        throw error;
      }
    }
  }
};

/** Restores only paths still matching staged bytes, refusing to overwrite external edits. */
const rollbackPreparedTransaction = async (
  root: string,
  prepared: PreparedTransaction,
): Promise<void> => {
  prepared.journal.status = 'rolling_back';
  await writeTransactionJournal(prepared);
  for (const entry of [...prepared.journal.entries].reverse()) {
    const destination = await resolveSafeProjectPath(root, entry.path);
    const currentHash = await readByteHash(destination);
    if (currentHash === entry.original_hash) {
      continue;
    }
    if (currentHash !== entry.next_hash) {
      throw new ProjectTransactionError(
        'project_recovery_required',
        'Rollback refused to overwrite externally authored data.',
        {
          path: entry.path,
          details: { transaction_id: prepared.journal.transaction_id },
        },
      );
    }

    if (entry.original_hash === null) {
      await unlink(destination);
    } else {
      if (entry.backup_path === null) {
        throw new ProjectTransactionError(
          'project_recovery_required',
          'Rollback backup is missing from the journal.',
          { path: entry.path },
        );
      }
      const backup = join(prepared.directory, entry.backup_path);
      if ((await readByteHash(backup)) !== entry.original_hash) {
        throw new ProjectTransactionError(
          'project_recovery_required',
          'Rollback backup does not match its journal hash.',
          { path: entry.path },
        );
      }
      const sibling = join(dirname(destination), `.attest-recovery-${randomUUID()}.tmp`);
      await copyFile(backup, sibling);
      await syncPath(sibling);
      await rename(sibling, destination);
    }
    await syncPath(dirname(destination));
  }
  await ensureExpectedState(root, prepared, 'original');
  await removeCreatedDirectories(root, prepared.journal.created_directories);
  prepared.journal.status = 'rolled_back';
  await writeTransactionJournal(prepared);
};

/** Removes a transaction directory only after commit verification or complete rollback. */
const cleanupPreparedTransaction = async (
  root: string,
  prepared: PreparedTransaction,
): Promise<void> => {
  await rm(prepared.directory, { recursive: true });
  await syncPath(join(root, TRANSACTIONS_DIRECTORY));
};

/** Recovers every interrupted journal under an already-owned project lock. */
const recoverProjectTransactions = async (
  root: string,
  lock: ProjectLockHandle,
): Promise<RecoveryResult[]> => {
  if (lock.root !== root) {
    throw new ProjectTransactionError('project_locked', 'Recovery lock belongs to another root.');
  }
  const transactionsRoot = join(root, TRANSACTIONS_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(transactionsRoot);
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const results: RecoveryResult[] = [];
  for (const name of names.sort()) {
    const directory = join(transactionsRoot, name);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProjectTransactionError(
        'project_recovery_required',
        'Unexpected recovery artifact is not a transaction directory.',
        { path: `${TRANSACTIONS_DIRECTORY}/${name}` },
      );
    }
    const prepared = await readPreparedTransaction(directory);
    const manifest = prepared.journal.entries.find(
      ({ path }) => path === prepared.journal.manifest_path,
    );
    if (manifest === undefined) {
      throw new ProjectTransactionError(
        'project_recovery_required',
        'Transaction journal does not contain the manifest commit point.',
        { path: `${TRANSACTIONS_DIRECTORY}/${name}/${JOURNAL_FILE}` },
      );
    }
    const manifestHash = await readByteHash(await resolveSafeProjectPath(root, manifest.path));
    // A code-only cloud revision can keep identical manifest bytes. In that case the
    // manifest cannot prove publication completed; only the committed journal can.
    const unchangedManifest = manifest.original_hash === manifest.next_hash;
    if (
      manifestHash === manifest.next_hash &&
      (!unchangedManifest || prepared.journal.status === 'committed')
    ) {
      await ensureExpectedState(root, prepared, 'next');
      prepared.journal.status = 'committed';
      await writeTransactionJournal(prepared);
      await cleanupPreparedTransaction(root, prepared);
      results.push({ action: 'completed_commit', transactionId: prepared.journal.transaction_id });
      continue;
    }
    if (manifestHash !== manifest.original_hash) {
      throw new ProjectTransactionError(
        'project_recovery_required',
        'Manifest no longer matches either transaction state.',
        {
          path: manifest.path,
          details: { transaction_id: prepared.journal.transaction_id },
        },
      );
    }
    await rollbackPreparedTransaction(root, prepared);
    await cleanupPreparedTransaction(root, prepared);
    results.push({ action: 'rolled_back', transactionId: prepared.journal.transaction_id });
  }
  return results;
};

export {
  TRANSACTIONS_DIRECTORY,
  cleanupPreparedTransaction,
  prepareTransaction,
  readByteHash,
  recoverProjectTransactions,
  rollbackPreparedTransaction,
  writeTransactionJournal,
  type PreparedTransaction,
  type TransactionFileChange,
  type TransactionJournalEntry,
};
