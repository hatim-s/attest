import { anchoredCall, type AnchoredFileFailure } from '../../internal/open-anchored.js';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import { annotateProjectCleanup, inspectProjectLock } from './project-lock.js';
import * as Effect from 'effect/Effect';
import { stripStruct } from '@attest/contracts';
import { utcTimestampSchema } from '../../internal/utc-timestamp.js';
import { parseWithSchemaSync } from '@attest/contracts';
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
import * as Schema from 'effect/Schema';
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
  | {
      contents: string;
      path: string;
      type: 'write';
    }
  | {
      path: string;
      type: 'remove';
    };

const canonicalPathSchema = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      path.length > 0 &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  ),
);

const authoredPathSchema = canonicalPathSchema.check(
  Schema.makeFilter((path) => path === 'attest.project.json' || path.startsWith('attest/')),
);

const hashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const originalFields = [
  { original_hash: Schema.Null, backup_path: Schema.Null },
  {
    original_hash: hashSchema,
    backup_path: Schema.String.check(Schema.isPattern(/^backups\/[0-9]+$/u)),
  },
] as const;

// Each branch decodes the combined fields, retaining the intersection's strip policy.
const transactionJournalEntrySchema = Schema.Union(
  originalFields.flatMap((original) => [
    stripStruct({
      ...original,
      type: Schema.Literal('write'),
      path: authoredPathSchema,
      staged_path: Schema.String.check(Schema.isPattern(/^staged\/[0-9]+$/u)),
      next_hash: hashSchema,
    }),
    stripStruct({
      ...original,
      type: Schema.Literal('remove'),
      path: authoredPathSchema,
      staged_path: Schema.Null,
      next_hash: Schema.Null,
    }),
  ]),
);

const transactionJournalSchema = stripStruct({
  completion: Schema.optional(
    stripStruct({
      path: Schema.Literal('.attest/cloud.json'),
      original_hash: Schema.NullOr(hashSchema),
      next_hash: hashSchema,
    }),
  ),
  created_at: utcTimestampSchema,
  created_directories: Schema.Array(
    canonicalPathSchema.check(
      Schema.makeFilter((path) => path === 'attest' || path.startsWith('attest/')),
    ),
  ),
  entries: Schema.Array(transactionJournalEntrySchema).check(Schema.isMinLength(1)),
  manifest_path: Schema.Literal('attest.project.json'),
  schema: Schema.Literal(TRANSACTION_JOURNAL_SCHEMA),
  status: Schema.Literals(['committed', 'prepared', 'publishing', 'rolled_back', 'rolling_back']),
  transaction_id: Schema.String.check(Schema.isUUID()),
}).check(
  Schema.makeFilter((journal) => {
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
  }),
);

type TransactionJournalEntry = typeof transactionJournalEntrySchema.Type;

type TransactionJournal = typeof transactionJournalSchema.Type;

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

/** Hashes exact disk bytes; only ENOENT represents an absent destination. */
const readByteHash = Effect.fn('readByteHash')(function* (path: string) {
  return yield* Effect.catch(
    Effect.gen(function* () {
      return hashBytes(yield* anchoredCall('readFile', path, () => readFile(path)));
    }),
    (error) =>
      Effect.gen(function* () {
        if (errnoCode(error) === 'ENOENT') {
          return null;
        }

        return yield* Effect.fail(error);
      }),
  );
}, Effect.uninterruptible);

/** Makes file bytes and their containing directory entry durable. */
const syncWrittenFile = Effect.fn('syncWrittenFile')(function* (path: string) {
  yield* syncPath(path);
  yield* syncPath(dirname(path));
}, Effect.uninterruptible);

/** Writes the recovery journal atomically so every visible version is complete JSON. */
const writeTransactionJournal = Effect.fn('writeTransactionJournal')(function* (
  prepared: PreparedTransaction,
) {
  const temporaryPath = join(prepared.directory, `.journal-${randomUUID()}.tmp`);
  yield* anchoredCall('writeFile', temporaryPath, () =>
    writeFile(temporaryPath, `${JSON.stringify(prepared.journal)}\n`, { mode: 0o600 }),
  );
  yield* syncPath(temporaryPath);
  yield* anchoredCall('rename', temporaryPath, () => rename(temporaryPath, prepared.journalPath));
  yield* syncPath(prepared.directory);
}, Effect.uninterruptible);

/** Records missing authored parents before publication for exact rollback. */
const missingParentDirectories = Effect.fn('missingParentDirectories')(function* (
  root: string,
  paths: readonly string[],
) {
  const missing = new Set<string>();

  for (const path of paths) {
    const segments = dirname(path)
      .split('/')
      .filter((segment) => segment !== '.');

    let current = '';

    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      yield* Effect.catch(
        Effect.gen(function* () {
          const metadata = yield* anchoredCall('lstat', join(root, current), () =>
            lstat(join(root, current)),
          );

          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            return yield* Effect.fail(
              new ProjectTransactionError(
                'project_invalid',
                'Transaction directory path is unsafe.',
                { path: current },
              ),
            );
          }
        }),
        (error) =>
          Effect.gen(function* () {
            if (errnoCode(error) !== 'ENOENT') {
              return yield* Effect.fail(error);
            }

            missing.add(current);
          }),
      );
    }
  }

  return [...missing].sort((left, right) => left.split('/').length - right.split('/').length);
}, Effect.uninterruptible);

/** Stages complete new contents, exact backups, and a durable pre-publish journal. */
const prepareTransaction = Effect.fn('prepareTransaction')(function* (
  root: string,
  changes: readonly TransactionFileChange[],
  options: {
    completion?: {
      path: '.attest/cloud.json';
      contents: string;
    };
  } = {},
) {
  const transactionId = randomUUID();

  const transactionsRoot = yield* resolveContainedPath(root, TRANSACTIONS_DIRECTORY, {
    expect: 'directory',
    createDirectories: true,
    problem: () =>
      new ProjectTransactionError('project_invalid', 'Unsafe transaction state directory.'),
  });

  const directory = join(transactionsRoot, `.preparing-${transactionId}`);
  const stagedDirectory = join(directory, 'staged');
  const backupDirectory = join(directory, 'backups');
  const entries: TransactionJournalEntry[] = [];

  const primary = yield* Effect.exit(
    Effect.gen(function* () {
      yield* anchoredCall('mkdir', stagedDirectory, () =>
        mkdir(stagedDirectory, { recursive: true }),
      );
      yield* anchoredCall('mkdir', backupDirectory, () =>
        mkdir(backupDirectory, { recursive: true }),
      );

      for (const [index, change] of changes.entries()) {
        const destination = yield* resolveSafeProjectPath(root, change.path);
        const originalHash = yield* readByteHash(destination);

        const original =
          originalHash === null
            ? { original_hash: null, backup_path: null }
            : { original_hash: originalHash, backup_path: `backups/${index}` };

        if (original.backup_path !== null) {
          const absoluteBackup = join(directory, original.backup_path);
          yield* anchoredCall('copyFile', destination, () => copyFile(destination, absoluteBackup));
          yield* syncWrittenFile(absoluteBackup);
        }

        const stagedPath = `staged/${index}`;

        if (change.type === 'write') {
          const absoluteStage = join(directory, stagedPath);
          yield* anchoredCall('writeFile', absoluteStage, () =>
            writeFile(absoluteStage, change.contents, { mode: 0o644 }),
          );
          yield* syncWrittenFile(absoluteStage);
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
            : {
                ...original,
                path: change.path,
                type: 'remove',
                staged_path: null,
                next_hash: null,
              },
        );
      }

      let journal: TransactionJournal = {
        schema: TRANSACTION_JOURNAL_SCHEMA,
        transaction_id: transactionId,
        created_at: new Date().toISOString(),
        status: 'prepared',
        manifest_path: 'attest.project.json',
        created_directories: yield* missingParentDirectories(
          root,
          changes.flatMap(({ type, path }) => (type === 'write' ? [path] : [])),
        ),
        entries,
      };

      const completion = options.completion;

      if (completion !== undefined) {
        const destination = yield* resolveContainedPath(root, completion.path, {
          expect: 'file',
          problem: () =>
            new ProjectTransactionError('project_invalid', 'Unsafe transaction completion path.'),
        });

        journal = {
          ...journal,
          completion: {
            path: completion.path,
            original_hash: yield* readByteHash(destination),
            next_hash: hashBytes(completion.contents),
          },
        };
        yield* anchoredCall('writeFile', join(directory, 'completion'), () =>
          writeFile(join(directory, 'completion'), completion.contents, { mode: 0o600 }),
        );
        yield* syncWrittenFile(join(directory, 'completion'));
      }

      const prepared = { directory, journal, journalPath: join(directory, JOURNAL_FILE) };
      yield* writeTransactionJournal(prepared);
      const publishedDirectory = join(transactionsRoot, transactionId);
      yield* anchoredCall('rename', directory, () => rename(directory, publishedDirectory));
      yield* syncPath(transactionsRoot);

      return {
        directory: publishedDirectory,
        journal,
        journalPath: join(publishedDirectory, JOURNAL_FILE),
      };
    }),
  );

  if (Exit.isFailure(primary)) {
    const cleanup = yield* Effect.exit(
      anchoredCall('rm', directory, () => rm(directory, { recursive: true, force: true })),
    );

    return yield* Effect.failCause(
      Exit.isFailure(cleanup)
        ? annotateProjectCleanup(primary.cause, cleanup.cause)
        : primary.cause,
    );
  }

  return primary.value;
}, Effect.uninterruptible);

// BOUNDARY: Durable transaction journal text is untrusted disk input; validate its schema and transaction directory identity before recovery.
const parseTransactionJournal = (raw: string, directory: string): TransactionJournal => {
  const path = relative(dirname(dirname(directory)), directory);

  try {
    return parseWithSchemaSync(
      transactionJournalSchema.check(
        Schema.makeFilter((journal) => journal.transaction_id === basename(directory)),
      ),
      JSON.parse(raw),
    );
  } catch (cause: unknown) {
    throw new ProjectTransactionError(
      'project_recovery_required',
      'Transaction journal is malformed or has an unsupported shape.',
      { path, cause },
    );
  }
};

/** Loads a transaction journal while keeping every recovery artifact in place on failure. */
const readPreparedTransaction = Effect.fn('readPreparedTransaction')(function* (directory: string) {
  const journalPath = yield* resolveContainedPath(directory, JOURNAL_FILE, {
    expect: 'file',
    problem: () =>
      new ProjectTransactionError('project_recovery_required', 'Unsafe recovery journal.'),
  });

  let raw: string;
  yield* Effect.catch(
    Effect.gen(function* () {
      raw = yield* anchoredCall('readFile', journalPath, () => readFile(journalPath, 'utf8'));
    }),
    (error) =>
      Effect.gen(function* () {
        return yield* Effect.fail(
          new ProjectTransactionError(
            'project_recovery_required',
            'Transaction directory is missing a readable journal.',
            { path: journalPath, cause: error },
          ),
        );
      }),
  );

  const journal = yield* Effect.try({
    try: () => parseTransactionJournal(raw, directory),
    catch: (cause) =>
      cause instanceof ProjectTransactionError
        ? cause
        : new ProjectTransactionError('project_recovery_required', 'Invalid recovery journal.', {
            cause,
          }),
  });

  for (const entry of journal.entries) {
    for (const path of [entry.backup_path, entry.staged_path]) {
      if (path === null) continue;
      yield* resolveContainedPath(directory, path, {
        expect: 'file',
        problem: () =>
          new ProjectTransactionError('project_recovery_required', 'Unsafe recovery artifact.', {
            path,
          }),
      });
    }
  }

  if (journal.completion !== undefined) {
    yield* resolveContainedPath(directory, 'completion', {
      expect: 'file',
      problem: () =>
        new ProjectTransactionError(
          'project_recovery_required',
          'Unsafe transaction completion artifact.',
        ),
    });
  }

  return { directory, journal, journalPath };
}, Effect.uninterruptible);

/** Refuses recovery when authored bytes diverge from the durable journal. */
const ensureExpectedState = Effect.fn('ensureExpectedState')(function* (
  root: string,
  prepared: PreparedTransaction,
  expected: 'next' | 'original',
) {
  for (const entry of prepared.journal.entries) {
    const destination = yield* resolveSafeProjectPath(root, entry.path);
    const expectedHash = expected === 'next' ? entry.next_hash : entry.original_hash;

    if ((yield* readByteHash(destination)) !== expectedHash) {
      return yield* Effect.fail(
        new ProjectTransactionError(
          'project_recovery_required',
          'Project path diverged from the recovery journal.',
          {
            path: entry.path,
            details: {
              expected_state: expected,
              transaction_id: prepared.journal.transaction_id,
            },
          },
        ),
      );
    }
  }
}, Effect.uninterruptible);

/** Attempts each generated parent cleanup, preserving every unexpected failure. */
const removeCreatedDirectories = Effect.fn('removeCreatedDirectories')(function* (
  root: string,
  paths: readonly string[],
) {
  let cleanup: Cause.Cause<AnchoredFileFailure | ProjectTransactionError> = Cause.empty;

  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    const removed = yield* Effect.exit(
      Effect.gen(function* () {
        const resolved = yield* resolveContainedPath(root, path, {
          expect: 'directory',
          problem: () =>
            new ProjectTransactionError('project_recovery_required', 'Unsafe recovery directory.', {
              path,
            }),
        });

        yield* anchoredCall('rmdir', resolved, () => rmdir(resolved)).pipe(
          Effect.catch((error) =>
            // Newly authored directory contents must remain in place.
            ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')
              ? Effect.void
              : Effect.fail(error),
          ),
        );
      }),
    );

    if (Exit.isFailure(removed)) cleanup = Cause.combine(cleanup, removed.cause);
  }

  if (cleanup.reasons.length > 0) return yield* Effect.failCause(cleanup);
}, Effect.uninterruptible);

/** Restores only paths still matching staged bytes, refusing to overwrite external edits. */
const rollbackPreparedTransaction = Effect.fn('rollbackPreparedTransaction')(function* (
  root: string,
  prepared: PreparedTransaction,
) {
  prepared.journal = { ...prepared.journal, status: 'rolling_back' };
  yield* writeTransactionJournal(prepared);

  for (const entry of [...prepared.journal.entries].reverse()) {
    const destination = yield* resolveSafeProjectPath(root, entry.path);
    const currentHash = yield* readByteHash(destination);

    if (currentHash === entry.original_hash) {
      continue;
    }

    if (currentHash !== entry.next_hash) {
      return yield* Effect.fail(
        new ProjectTransactionError(
          'project_recovery_required',
          'Rollback refused to overwrite externally authored data.',
          {
            path: entry.path,
            details: { transaction_id: prepared.journal.transaction_id },
          },
        ),
      );
    }

    if (entry.original_hash === null) {
      yield* anchoredCall('unlink', destination, () => unlink(destination));
    } else {
      const backup = join(prepared.directory, entry.backup_path);

      if ((yield* readByteHash(backup)) !== entry.original_hash) {
        return yield* Effect.fail(
          new ProjectTransactionError(
            'project_recovery_required',
            'Rollback backup does not match its journal hash.',
            { path: entry.path },
          ),
        );
      }

      const sibling = join(dirname(destination), `.attest-recovery-${randomUUID()}.tmp`);
      yield* anchoredCall('copyFile', backup, () => copyFile(backup, sibling));
      yield* syncPath(sibling);
      yield* anchoredCall('rename', sibling, () => rename(sibling, destination));
    }

    yield* syncPath(dirname(destination));
  }

  yield* ensureExpectedState(root, prepared, 'original');
  yield* removeCreatedDirectories(root, prepared.journal.created_directories);
  prepared.journal = { ...prepared.journal, status: 'rolled_back' };
  yield* writeTransactionJournal(prepared);
}, Effect.uninterruptible);

/** Completes durable state only after authored files have committed, including after a crash. */
const completePreparedTransaction = Effect.fn('completePreparedTransaction')(function* (
  root: string,
  prepared: PreparedTransaction,
) {
  const completion = prepared.journal.completion;

  if (completion === undefined) return;

  const destination = yield* resolveContainedPath(root, completion.path, {
    expect: 'file',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction completion path.',
      ),
  });

  const current = yield* readByteHash(destination);

  if (current === completion.next_hash) {
    yield* syncPath(dirname(destination));

    return;
  }

  const staged = yield* resolveContainedPath(prepared.directory, 'completion', {
    expect: 'file',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction completion artifact.',
      ),
  });

  if (
    current !== completion.original_hash ||
    (yield* readByteHash(staged)) !== completion.next_hash
  ) {
    return yield* Effect.fail(
      new ProjectTransactionError(
        'project_recovery_required',
        'Transaction completion state diverged from its journal.',
        { path: completion.path },
      ),
    );
  }

  yield* anchoredCall('rename', staged, () => rename(staged, destination));
  yield* syncPath(dirname(destination));
}, Effect.uninterruptible);

/** Removes a transaction directory only after commit verification or complete rollback. */
const cleanupPreparedTransaction = Effect.fn('cleanupPreparedTransaction')(function* (
  root: string,
  prepared: PreparedTransaction,
) {
  const transactionsRoot = yield* resolveContainedPath(root, TRANSACTIONS_DIRECTORY, {
    expect: 'directory',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction state directory.',
      ),
  });

  const retired = join(transactionsRoot, `.cleanup-${prepared.journal.transaction_id}`);
  yield* anchoredCall('rename', prepared.directory, () => rename(prepared.directory, retired));
  yield* syncPath(transactionsRoot);
  yield* anchoredCall('rm', retired, () => rm(retired, { recursive: true }));
  yield* syncPath(transactionsRoot);
}, Effect.uninterruptible);

/** Recovers every interrupted journal under an already-owned project lock. */
const recoverProjectTransactions = Effect.fn('recoverProjectTransactions')(function* (
  root: string,
  lock: ProjectLockHandle,
) {
  if (lock.root !== root) {
    return yield* Effect.fail(
      new ProjectTransactionError('project_locked', 'Recovery lock belongs to another root.'),
    );
  }

  const owner = yield* inspectProjectLock(root);

  if (
    owner.state === 'absent' ||
    owner.state === 'invalid' ||
    owner.metadata.owner_token !== lock.metadata.owner_token
  )
    return yield* Effect.fail(
      new ProjectTransactionError('project_locked', 'Recovery lock ownership changed.'),
    );

  const identity = yield* anchoredCall('lstat', lock.path, () =>
    lstat(lock.path, { bigint: true }),
  );

  if (identity.dev !== lock.identity.dev || identity.ino !== lock.identity.ino)
    return yield* Effect.fail(
      new ProjectTransactionError('project_locked', 'Recovery lock inode changed.'),
    );

  const transactionsRoot = yield* resolveContainedPath(root, TRANSACTIONS_DIRECTORY, {
    expect: 'directory',
    problem: () =>
      new ProjectTransactionError(
        'project_recovery_required',
        'Unsafe transaction state directory.',
      ),
  });

  let names: string[] = [];
  yield* Effect.catch(
    Effect.gen(function* () {
      names = yield* anchoredCall('readdir', transactionsRoot, () => readdir(transactionsRoot));
    }),
    (error) =>
      Effect.gen(function* () {
        if (errnoCode(error) === 'ENOENT') {
          names = [];

          return;
        }

        return yield* Effect.fail(error);
      }),
  );
  const results: RecoveryResult[] = [];

  for (const name of names.sort()) {
    const directory = join(transactionsRoot, name);
    const metadata = yield* anchoredCall('lstat', directory, () => lstat(directory));

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return yield* Effect.fail(
        new ProjectTransactionError(
          'project_recovery_required',
          'Unexpected recovery artifact is not a transaction directory.',
          { path: `${TRANSACTIONS_DIRECTORY}/${name}` },
        ),
      );
    }

    if (/^\.(preparing|cleanup)-[a-f0-9-]{36}$/u.test(name)) {
      yield* anchoredCall('rm', directory, () => rm(directory, { recursive: true }));
      yield* syncPath(transactionsRoot);
      continue;
    }

    const prepared = yield* readPreparedTransaction(directory);

    // The journal schema requires the manifest as the last write entry.
    const manifest = prepared.journal.entries.find(
      ({ path }) => path === prepared.journal.manifest_path,
    )!;

    const manifestHash = yield* readByteHash(yield* resolveSafeProjectPath(root, manifest.path));
    // A code-only cloud revision can keep identical manifest bytes. In that case the
    // manifest cannot prove publication completed; only the committed journal can.
    const unchangedManifest = manifest.original_hash === manifest.next_hash;

    if (
      manifestHash === manifest.next_hash &&
      (!unchangedManifest || prepared.journal.status === 'committed')
    ) {
      yield* ensureExpectedState(root, prepared, 'next');
      prepared.journal = { ...prepared.journal, status: 'committed' };
      yield* writeTransactionJournal(prepared);
      yield* completePreparedTransaction(root, prepared);
      yield* cleanupPreparedTransaction(root, prepared);
      results.push({ action: 'completed_commit', transactionId: prepared.journal.transaction_id });
      continue;
    }

    if (manifestHash !== manifest.original_hash) {
      return yield* Effect.fail(
        new ProjectTransactionError(
          'project_recovery_required',
          'Manifest no longer matches either transaction state.',
          {
            path: manifest.path,
            details: { transaction_id: prepared.journal.transaction_id },
          },
        ),
      );
    }

    yield* rollbackPreparedTransaction(root, prepared);
    yield* cleanupPreparedTransaction(root, prepared);
    results.push({ action: 'rolled_back', transactionId: prepared.journal.transaction_id });
  }

  return results;
}, Effect.uninterruptible);

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
