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
import { basename, dirname, join, relative } from 'node:path';

import { z } from 'zod';

import { resolveContainedPath } from '../project-path.js';
import { errnoCode } from '../../internal/errno-code.js';
import { syncPath } from '../../internal/sync-path.js';
import type { ProjectLockHandle } from './project-lock.js';
import { resolveSafeProjectPath } from './project-path.js';
import { ProjectTransactionError } from './project-transaction-error.js';

const TRANSACTIONS_DIRECTORY = '.attest/transactions';

const TRANSACTION_JOURNAL_SCHEMA = 'attest.project-transaction';

const JOURNAL_FILE = 'journal.json';

type TransactionFileChange =
  { contents: string; path: string; type: 'write' } | { path: string; type: 'remove' };

const canonicalPathSchema = z
  .string()
  .refine(
    (path) =>
      path.length > 0 &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  );

const authoredPathSchema = canonicalPathSchema.refine(
  (path) => path === 'attest.project.json' || path.startsWith('attest/'),
);

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const originalSchema = z.union([
  z.object({ original_hash: z.null(), backup_path: z.null() }),
  z.object({ original_hash: hashSchema, backup_path: z.string().regex(/^backups\/[0-9]+$/u) }),
]);

const transactionJournalEntrySchema = z.intersection(
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('write'),
      path: authoredPathSchema,
      staged_path: z.string().regex(/^staged\/[0-9]+$/u),
      next_hash: hashSchema,
    }),
    z.object({
      type: z.literal('remove'),
      path: authoredPathSchema,
      staged_path: z.null(),
      next_hash: z.null(),
    }),
  ]),
  originalSchema,
);

const transactionJournalSchema = z
  .object({
    completion: z
      .object({
        path: z.literal('.attest/cloud.json'),
        original_hash: hashSchema.nullable(),
        next_hash: hashSchema,
      })
      .optional(),
    created_at: z.iso.datetime(),
    created_directories: z.array(
      canonicalPathSchema.refine((path) => path === 'attest' || path.startsWith('attest/')),
    ),
    entries: z.array(transactionJournalEntrySchema).min(1),
    manifest_path: z.literal('attest.project.json'),
    project_hash_after: z.string(),
    project_hash_before: z.string(),
    published_count: z.number().int().nonnegative(),
    schema: z.literal(TRANSACTION_JOURNAL_SCHEMA),
    status: z.enum(['committed', 'prepared', 'publishing', 'rolled_back', 'rolling_back']),
    transaction_id: z.uuid(),
  })
  .refine((journal) => {
    const paths = journal.entries.map(({ path }) => path);

    return (
      new Set(paths).size === paths.length &&
      paths.at(-1) === journal.manifest_path &&
      journal.entries.at(-1)?.type === 'write' &&
      new Set(journal.created_directories).size === journal.created_directories.length &&
      journal.created_directories.every((directory) =>
        journal.entries.some(
          (entry) => entry.type === 'write' && entry.path.startsWith(`${directory}/`),
        ),
      ) &&
      journal.entries.every(
        (entry, index) =>
          (entry.backup_path === null || entry.backup_path === `backups/${index}`) &&
          (entry.type === 'remove' || entry.staged_path === `staged/${index}`),
      )
    );
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
  options: {
    projectHashBefore: string;
    projectHashAfter: string;
    completion?: { path: '.attest/cloud.json'; contents: string };
  },
): Promise<PreparedTransaction> => {
  const transactionId = randomUUID();

  const transactionsRoot = await resolveContainedPath(root, TRANSACTIONS_DIRECTORY, {
    expect: 'directory',
    createDirectories: true,
    problem: () =>
      new ProjectTransactionError('project_invalid', 'Unsafe transaction state directory.'),
  });

  const directory = join(transactionsRoot, `.preparing-${transactionId}`);
  const stagedDirectory = join(directory, 'staged');
  const backupDirectory = join(directory, 'backups');

  const entries: TransactionJournalEntry[] = [];

  try {
    await mkdir(stagedDirectory, { recursive: true });
    await mkdir(backupDirectory, { recursive: true });

    for (const [index, change] of changes.entries()) {
      const destination = await resolveSafeProjectPath(root, change.path);
      const originalHash = await readByteHash(destination);

      const original =
        originalHash === null
          ? { original_hash: null, backup_path: null }
          : { original_hash: originalHash, backup_path: `backups/${index}` };

      if (original.backup_path !== null) {
        const absoluteBackup = join(directory, original.backup_path);
        await copyFile(destination, absoluteBackup);
        await syncWrittenFile(absoluteBackup);
      }

      const stagedPath = `staged/${index}`;

      if (change.type === 'write') {
        const absoluteStage = join(directory, stagedPath);
        await writeFile(absoluteStage, change.contents, { mode: 0o644 });
        await syncWrittenFile(absoluteStage);
      }

      entries.push(
        change.type === 'write'
          ? {
              ...original,
              path: change.path,
              type: 'write',
              staged_path: stagedPath,
              next_hash: hashBytes(change.contents),
            }
          : { ...original, path: change.path, type: 'remove', staged_path: null, next_hash: null },
      );
    }

    const journal: TransactionJournal = {
      schema: TRANSACTION_JOURNAL_SCHEMA,
      transaction_id: transactionId,
      created_at: new Date().toISOString(),
      status: 'prepared',
      manifest_path: 'attest.project.json',
      project_hash_before: options.projectHashBefore,
      project_hash_after: options.projectHashAfter,
      published_count: 0,
      created_directories: await missingParentDirectories(
        root,
        changes.flatMap(({ type, path }) => (type === 'write' ? [path] : [])),
      ),
      entries,
    };

    if (options.completion !== undefined) {
      const destination = await resolveContainedPath(root, options.completion.path, {
        expect: 'file',
        problem: () =>
          new ProjectTransactionError('project_invalid', 'Unsafe transaction completion path.'),
      });

      journal.completion = {
        path: options.completion.path,
        original_hash: await readByteHash(destination),
        next_hash: hashBytes(options.completion.contents),
      };
      await writeFile(join(directory, 'completion'), options.completion.contents, { mode: 0o600 });
      await syncWrittenFile(join(directory, 'completion'));
    }

    const prepared = { directory, journal, journalPath: join(directory, JOURNAL_FILE) };
    await writeTransactionJournal(prepared);
    const publishedDirectory = join(transactionsRoot, transactionId);
    await rename(directory, publishedDirectory);
    await syncPath(transactionsRoot);

    return {
      directory: publishedDirectory,
      journal,
      journalPath: join(publishedDirectory, JOURNAL_FILE),
    };
  } catch (cause: unknown) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Recovery removes staging residue if cleanup also fails.
    }

    throw cause;
  }
};

// BOUNDARY: Durable transaction journal text is untrusted disk input; validate its schema and transaction directory identity before recovery.
const parseTransactionJournal = (raw: string, directory: string): TransactionJournal => {
  const path = relative(dirname(dirname(directory)), directory);

  try {
    return transactionJournalSchema
      .refine((journal) => journal.transaction_id === basename(directory))
      .parse(JSON.parse(raw));
  } catch (cause: unknown) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Transaction journal is malformed or has an unsupported shape.',
      { path, cause },
    );
  }
};

/** Loads a transaction journal while keeping every recovery artifact in place on failure. */
const readPreparedTransaction = async (directory: string): Promise<PreparedTransaction> => {
  const journalPath = await resolveContainedPath(directory, JOURNAL_FILE, {
    expect: 'file',
    problem: () =>
      new ProjectTransactionError('project_recovery_required', 'Unsafe recovery journal.'),
  });

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

  const journal = parseTransactionJournal(raw, directory);

  for (const entry of journal.entries) {
    for (const path of [entry.backup_path, entry.staged_path]) {
      if (path === null) continue;
      await resolveContainedPath(directory, path, {
        expect: 'file',
        problem: () =>
          new ProjectTransactionError('project_recovery_required', 'Unsafe recovery artifact.', {
            path,
          }),
      });
    }
  }

  if (journal.completion !== undefined) {
    await resolveContainedPath(directory, 'completion', {
      expect: 'file',
      problem: () =>
        new ProjectTransactionError(
          'project_recovery_required',
          'Unsafe transaction completion artifact.',
        ),
    });
  }

  return { directory, journal, journalPath };
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
      await rmdir(
        await resolveContainedPath(root, path, {
          expect: 'directory',
          problem: () =>
            new ProjectTransactionError('project_recovery_required', 'Unsafe recovery directory.', {
              path,
            }),
        }),
      );
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

/** Completes durable state only after authored files have committed, including after a crash. */
const completePreparedTransaction = async (
  root: string,
  prepared: PreparedTransaction,
): Promise<void> => {
  const completion = prepared.journal.completion;

  if (completion === undefined) return;

  const destination = await resolveContainedPath(root, completion.path, {
    expect: 'file',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction completion path.',
      ),
  });

  const current = await readByteHash(destination);

  if (current === completion.next_hash) {
    await syncPath(dirname(destination));

    return;
  }

  const staged = await resolveContainedPath(prepared.directory, 'completion', {
    expect: 'file',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction completion artifact.',
      ),
  });

  if (
    current !== completion.original_hash ||
    (await readByteHash(staged)) !== completion.next_hash
  ) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Transaction completion state diverged from its journal.',
      { path: completion.path },
    );
  }

  await rename(staged, destination);
  await syncPath(dirname(destination));
};

/** Removes a transaction directory only after commit verification or complete rollback. */
const cleanupPreparedTransaction = async (
  root: string,
  prepared: PreparedTransaction,
): Promise<void> => {
  const transactionsRoot = await resolveContainedPath(root, TRANSACTIONS_DIRECTORY, {
    expect: 'directory',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction state directory.',
      ),
  });

  const retired = join(transactionsRoot, `.cleanup-${prepared.journal.transaction_id}`);
  await rename(prepared.directory, retired);
  await syncPath(transactionsRoot);
  await rm(retired, { recursive: true });
  await syncPath(transactionsRoot);
};

/** Recovers every interrupted journal under an already-owned project lock. */
const recoverProjectTransactions = async (
  root: string,
  lock: ProjectLockHandle,
): Promise<RecoveryResult[]> => {
  if (lock.root !== root) {
    throw new ProjectTransactionError('project_locked', 'Recovery lock belongs to another root.');
  }

  const transactionsRoot = await resolveContainedPath(root, TRANSACTIONS_DIRECTORY, {
    expect: 'directory',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction state directory.',
      ),
  });

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

    if (/^\.(preparing|cleanup)-[a-f0-9-]{36}$/u.test(name)) {
      await rm(directory, { recursive: true });
      await syncPath(transactionsRoot);
      continue;
    }

    const prepared = await readPreparedTransaction(directory);

    // The journal schema requires the manifest as the last write entry.
    const manifest = prepared.journal.entries.find(
      ({ path }) => path === prepared.journal.manifest_path,
    )!;

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
      await completePreparedTransaction(root, prepared);
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
  completePreparedTransaction,
  prepareTransaction,
  readByteHash,
  recoverProjectTransactions,
  rollbackPreparedTransaction,
  writeTransactionJournal,
  type PreparedTransaction,
  type TransactionFileChange,
  type TransactionJournalEntry,
};
