import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { acquireProjectLock, releaseProjectLock } from '../project-lock.js';
import { prepareTransaction, recoverProjectTransactions } from '../transaction-journal.js';

const roots: string[] = [];

const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-journal-boundary-'));
  roots.push(root);
  await writeFile(join(root, 'attest.project.json'), 'old');

  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(['backup', 'directory', 'identity', 'duplicate', 'write', 'remove'])(
  'rejects a forged %s before touching recovery artifacts',
  async (kind) => {
    const root = await createRoot();
    const outside = await createRoot();
    const empty = join(outside, 'empty');
    await mkdir(empty);

    const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
      valueFromExit(exit),
    );

    try {
      const prepared = await Effect.runPromiseExit(
        prepareTransaction(root, [{ type: 'write', path: 'attest.project.json', contents: 'new' }]),
      ).then((exit) => valueFromExit(exit));

      const journal = prepared.journal;
      const entry = journal.entries[0]!;

      const forged = {
        ...journal,
        transaction_id:
          kind === 'identity' ? '00000000-0000-4000-8000-000000000000' : journal.transaction_id,
        created_directories: kind === 'directory' ? [relative(root, empty)] : [],
        entries:
          kind === 'duplicate'
            ? [entry, entry]
            : [
                {
                  ...entry,
                  backup_path:
                    kind === 'backup'
                      ? relative(prepared.directory, join(outside, 'attest.project.json'))
                      : entry.backup_path,
                  staged_path: kind === 'write' ? null : entry.staged_path,
                  type: kind === 'remove' ? 'remove' : entry.type,
                },
              ],
      };

      const raw = JSON.stringify(forged);
      await writeFile(prepared.journalPath, raw);
      await expect(
        Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
          valueFromExit(exit),
        ),
      ).rejects.toMatchObject({
        code: 'project_recovery_required',
        message: 'Transaction journal is malformed or has an unsupported shape.',
      });
      expect(await readFile(prepared.journalPath, 'utf8')).toBe(raw);
      expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('old');
      expect(await readFile(join(outside, 'attest.project.json'), 'utf8')).toBe('old');
      expect(await readdir(empty)).toEqual([]);
    } finally {
      await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
    }
  },
);

it('rejects symlinked state at .attest', async () => {
  const root = await createRoot();
  const outside = await createRoot();
  await symlink(outside, join(root, '.attest'));

  await expect(
    Effect.runPromiseExit(acquireProjectLock(root)).then((exit) => valueFromExit(exit)),
  ).rejects.toMatchObject({ code: 'project_invalid' });
  expect(await readdir(outside)).toEqual(['attest.project.json']);
});

it('rejects symlinked state at .attest/transactions', async () => {
  const root = await createRoot();
  const outside = await createRoot();
  await mkdir(join(root, '.attest'));
  await symlink(outside, join(root, '.attest/transactions'));

  const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
    valueFromExit(exit),
  );

  try {
    await expect(
      Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
        valueFromExit(exit),
      ),
    ).rejects.toMatchObject({
      code: 'project_recovery_required',
    });
    await expect(
      Effect.runPromiseExit(prepareTransaction(root, [])).then((exit) => valueFromExit(exit)),
    ).rejects.toMatchObject({
      code: 'project_invalid',
    });
  } finally {
    await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
  }

  expect(await readdir(outside)).toEqual(['attest.project.json']);
});
