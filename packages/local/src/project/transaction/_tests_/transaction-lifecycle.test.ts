import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import { open, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { LocalError } from '../../../errors/index.js';
import {
  acquireProjectLock,
  releaseProjectLock,
  withProjectLock,
  ProjectLockCleanup,
} from '../project-lock.js';
import { prepareTransaction, recoverProjectTransactions } from '../transaction-journal.js';
import { runPreparedTransaction } from '../transactional-writer.js';

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

it.each(['preparing', 'cleanup'])('removes interrupted %s residue under the lock', async (kind) => {
  const root = await createRoot();

  const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
    valueFromExit(exit),
  );

  try {
    const interrupted = join(
      root,
      `.attest/transactions/.${kind}-00000000-0000-4000-8000-000000000000`,
    );

    await mkdir(join(interrupted, 'staged'), { recursive: true });
    await writeFile(join(interrupted, 'staged/0'), 'partial');
    expect(
      await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
        valueFromExit(exit),
      ),
    ).toEqual([]);
    expect(await readdir(join(root, '.attest/transactions'))).toEqual([]);

    const prepared = await Effect.runPromiseExit(
      prepareTransaction(root, [{ type: 'write', path: 'attest.project.json', contents: 'new' }]),
    ).then((exit) => valueFromExit(exit));

    expect(
      await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
        valueFromExit(exit),
      ),
    ).toEqual([{ action: 'rolled_back', transactionId: prepared.journal.transaction_id }]);
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('old');
  } finally {
    await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
  }
});

it('cleans a failed preparation without publishing a recoverable directory', async () => {
  const root = await createRoot();

  const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
    valueFromExit(exit),
  );

  try {
    await mkdir(join(root, 'attest'));
    await mkdir(join(root, 'attest/not-a-file'));
    await expect(
      Effect.runPromiseExit(
        prepareTransaction(root, [{ type: 'write', path: 'attest/not-a-file', contents: 'new' }]),
      ).then((exit) => valueFromExit(exit)),
    ).rejects.toMatchObject({ code: 'project_invalid' });
    expect(await readdir(join(root, '.attest/transactions'))).toEqual([]);
    expect(
      await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
        valueFromExit(exit),
      ),
    ).toEqual([]);
  } finally {
    await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
  }
});

it('retains committed bytes and recovery evidence when cleanup fails', async () => {
  const root = await createRoot();

  const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
    valueFromExit(exit),
  );

  const transactionsRoot = join(root, '.attest/transactions');
  let collision: string | undefined;

  try {
    const prepared = await Effect.runPromiseExit(
      prepareTransaction(root, [{ type: 'write', path: 'attest.project.json', contents: 'new' }]),
    ).then((exit) => valueFromExit(exit));

    collision = join(transactionsRoot, `.cleanup-${prepared.journal.transaction_id}`);
    await mkdir(collision);
    await writeFile(join(collision, 'occupied'), 'preserve');
    await expect(
      Effect.runPromiseExit(
        runPreparedTransaction({ root, prepared, verify: () => Effect.void }),
      ).then((exit) => valueFromExit(exit)),
    ).rejects.toMatchObject({
      name: 'ProjectTransactionError',
      code: 'project_saved_cleanup_failed',
      details: { committed: true, transaction_id: prepared.journal.transaction_id },
    });
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('new');
    expect(await readFile(prepared.journalPath, 'utf8')).toContain('"committed"');
    expect(
      await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
        valueFromExit(exit),
      ),
    ).toEqual([{ action: 'completed_commit', transactionId: prepared.journal.transaction_id }]);
    expect(await readdir(transactionsRoot)).toEqual([]);
  } finally {
    if (collision !== undefined) await rm(collision, { recursive: true, force: true });
    await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
  }
});

it('preserves a project_changed error thrown before publication', async () => {
  const root = await createRoot();

  const prepared = await Effect.runPromiseExit(
    prepareTransaction(root, [{ type: 'write', path: 'attest.project.json', contents: 'new' }]),
  ).then((exit) => valueFromExit(exit));

  const conflict = new LocalError('project_changed', 'A local file changed while staging.');

  await expect(
    Effect.runPromiseExit(
      runPreparedTransaction({
        root,
        prepared,
        beforePublish: () =>
          Effect.gen(function* () {
            return yield* Effect.fail(conflict);
          }),
        verify: () => Effect.void,
      }),
    ).then((exit) => valueFromExit(exit)),
  ).rejects.toBe(conflict);
  expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('old');
});

it('joins pending journal fsync before releasing an interrupted transaction lock', async () => {
  const root = await createRoot();
  const probe = await open(join(root, 'attest.project.json'), 'r');
  // SAFETY: The prototype comes from a real Node FileHandle, whose sync method is exercised below.
  const prototype = Object.getPrototypeOf(probe) as { sync: (this: typeof probe) => Promise<void> };
  await probe.close();
  const original = prototype.sync;
  let unblock = () => {};

  let entered = () => {};

  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });

  let active = false;
  let intercepted = false;

  const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof probe) {
    if (active && !intercepted) {
      intercepted = true;
      entered();
      await gate;
    }

    await original.call(this);
  });

  const controller = new AbortController();
  let settled = false;

  const running = Effect.runPromiseExit(
    withProjectLock(root, () =>
      Effect.gen(function* () {
        active = true;

        return yield* prepareTransaction(root, [
          { type: 'write', path: 'attest.project.json', contents: 'new' },
        ]);
      }),
    ),
    { signal: controller.signal },
  ).then((exit) => {
    settled = true;

    return exit;
  });

  try {
    await waiting;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await readFile(join(root, '.attest/project.lock'), 'utf8')).toContain('owner_token');
    unblock();
    await running;
    await expect(readFile(join(root, '.attest/project.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    unblock();
    await running;
    spy.mockRestore();
  }
});

it.each(['failure', 'defect', 'success'] as const)(
  'preserves %s with failed lock release evidence',
  async (kind) => {
    const root = await createRoot();
    const primary = new LocalError('project_changed', 'Primary conflict.');

    const exit = await Effect.runPromiseExit(
      withProjectLock(
        root,
        (lock) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              writeFile(
                lock.path,
                JSON.stringify({ ...lock.metadata, owner_token: 'replacement' }),
              ),
            );

            if (kind === 'failure') return yield* Effect.fail(primary);

            if (kind === 'defect') return yield* Effect.die(primary);

            return { committed: true, transaction_id: 'verified-transaction' };
          }),
        (value) => value,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      if (kind === 'failure') expect(Cause.squash(exit.cause)).toBe(primary);

      if (kind === 'defect') expect(Cause.hasDies(exit.cause)).toBe(true);

      if (kind === 'success')
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: 'project_saved_cleanup_failed',
          details: { committed: true, transaction_id: 'verified-transaction' },
        });
      else
        expect(
          Context.getOrUndefined(Cause.annotations(exit.cause), ProjectLockCleanup)?.reasons
            .length ?? 0,
        ).toBeGreaterThan(0);
    }

    expect(await readFile(join(root, '.attest/project.lock'), 'utf8')).toContain('replacement');
  },
);

it('requires recovery when publication and automatic rollback both fail', async () => {
  const root = await createRoot();
  await mkdir(join(root, 'attest'));
  await writeFile(join(root, 'attest/resource.json'), 'original');

  const prepared = valueFromExit(
    await Effect.runPromiseExit(
      prepareTransaction(root, [
        { type: 'write', path: 'attest/resource.json', contents: 'updated' },
        { type: 'write', path: 'attest.project.json', contents: 'new' },
      ]),
    ),
  );

  await rm(join(prepared.directory, 'staged/1'));
  await writeFile(join(prepared.directory, 'backups/0'), 'tampered');
  await expect(
    Effect.runPromiseExit(
      runPreparedTransaction({
        root,
        prepared,
        verify: () => Effect.void,
      }),
    ).then(valueFromExit),
  ).rejects.toMatchObject({
    code: 'project_recovery_required',
    message: 'Transaction failed and automatic rollback could not complete.',
    details: { transaction_id: prepared.journal.transaction_id },
  });
  expect(await readFile(join(root, 'attest/resource.json'), 'utf8')).toBe('updated');
  expect(await readFile(prepared.journalPath, 'utf8')).toContain(prepared.journal.transaction_id);
});

it('reports restored state when writing the commit journal fails', async () => {
  const root = await createRoot();

  const prepared = valueFromExit(
    await Effect.runPromiseExit(
      prepareTransaction(root, [{ type: 'write', path: 'attest.project.json', contents: 'new' }]),
    ),
  );

  const probe = await open(join(root, 'attest.project.json'), 'r');
  // SAFETY: This prototype belongs to a real Node FileHandle; only one commit fsync fails.
  const prototype = Object.getPrototypeOf(probe) as { sync: (this: typeof probe) => Promise<void> };
  await probe.close();
  const sync = prototype.sync;
  let verified = false;
  let failed = false;

  const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof probe) {
    if (verified && !failed) {
      failed = true;
      throw new Error('Commit journal fsync failed.');
    }

    await sync.call(this);
  });

  try {
    await expect(
      Effect.runPromiseExit(
        runPreparedTransaction({
          root,
          prepared,
          verify: () =>
            Effect.sync(() => {
              verified = true;
            }),
        }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'project_transaction_failed',
      message: 'Transaction failed; the prior project was restored.',
      details: { transaction_id: prepared.journal.transaction_id },
    });
    expect(failed).toBe(true);
  } finally {
    spy.mockRestore();
  }

  expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('old');
  expect(await readdir(join(root, '.attest/transactions'))).toEqual([]);
});

it('keeps a verification defect when compensation fails', async () => {
  const root = await createRoot();

  const prepared = valueFromExit(
    await Effect.runPromiseExit(
      prepareTransaction(root, [{ type: 'write', path: 'attest.project.json', contents: 'new' }]),
    ),
  );

  const defect = new Error('Verification crashed.');
  await writeFile(join(prepared.directory, 'backups/0'), 'tampered');

  const exit = await Effect.runPromiseExit(
    runPreparedTransaction({
      root,
      prepared,
      verify: () => Effect.die(defect),
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.squash(exit.cause)).toBe(defect);
    expect(Context.getOrUndefined(Cause.annotations(exit.cause), ProjectLockCleanup)).toBeDefined();
  }
});
