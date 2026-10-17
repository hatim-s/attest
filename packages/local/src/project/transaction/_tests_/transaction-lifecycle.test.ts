import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { acquireProjectLock, releaseProjectLock } from '../project-lock.js';
import {
  cleanupPreparedTransaction,
  prepareTransaction,
  recoverProjectTransactions,
  writeTransactionJournal,
} from '../transaction-journal.js';
import { publishPreparedTransaction } from '../transactional-writer.js';

const roots: string[] = [];

const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-transaction-lifecycle-'));
  roots.push(root);
  await writeFile(join(root, 'attest.project.json'), 'old');

  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('ignores preparation interrupted before its first durable journal', async () => {
  const root = await createRoot();
  const lock = await acquireProjectLock(root);

  try {
    const interrupted = join(
      root,
      '.attest/transactions/.preparing-00000000-0000-4000-8000-000000000000',
    );

    await mkdir(join(interrupted, 'staged'), { recursive: true });
    await writeFile(join(interrupted, 'staged/0'), 'partial');
    expect(await recoverProjectTransactions(root, lock)).toEqual([]);

    const prepared = await prepareTransaction(
      root,
      [{ type: 'write', path: 'attest.project.json', contents: 'new' }],
      'before',
      'after',
    );

    expect(await recoverProjectTransactions(root, lock)).toEqual([
      { action: 'rolled_back', transactionId: prepared.journal.transaction_id },
    ]);
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('old');
  } finally {
    await releaseProjectLock(lock);
  }
});

it('cleans a failed preparation without publishing a recoverable directory', async () => {
  const root = await createRoot();
  const lock = await acquireProjectLock(root);

  try {
    await mkdir(join(root, 'attest'));
    await mkdir(join(root, 'attest/not-a-file'));
    await expect(
      prepareTransaction(
        root,
        [{ type: 'write', path: 'attest/not-a-file', contents: 'new' }],
        'before',
        'after',
      ),
    ).rejects.toMatchObject({ code: 'project_invalid' });
    expect(await readdir(join(root, '.attest/transactions'))).toEqual([]);
    expect(await recoverProjectTransactions(root, lock)).toEqual([]);
  } finally {
    await releaseProjectLock(lock);
  }
});

it('retains committed bytes and recovery evidence when cleanup fails', async () => {
  const root = await createRoot();
  const lock = await acquireProjectLock(root);
  const transactionsRoot = join(root, '.attest/transactions');
  let collision: string | undefined;

  try {
    const prepared = await prepareTransaction(
      root,
      [{ type: 'write', path: 'attest.project.json', contents: 'new' }],
      'before',
      'after',
    );

    await publishPreparedTransaction(root, prepared);
    prepared.journal.status = 'committed';
    await writeTransactionJournal(prepared);
    collision = join(transactionsRoot, `.cleanup-${prepared.journal.transaction_id}`);
    await mkdir(collision);
    await writeFile(join(collision, 'occupied'), 'preserve');
    await expect(cleanupPreparedTransaction(root, prepared)).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    });
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('new');
    expect(await readFile(prepared.journalPath, 'utf8')).toContain('"committed"');
    await rm(collision, { recursive: true });
    expect(await recoverProjectTransactions(root, lock)).toEqual([
      { action: 'completed_commit', transactionId: prepared.journal.transaction_id },
    ]);
    expect(await readdir(transactionsRoot)).toEqual([]);
  } finally {
    if (collision !== undefined) await rm(collision, { recursive: true, force: true });
    await releaseProjectLock(lock);
  }
});
