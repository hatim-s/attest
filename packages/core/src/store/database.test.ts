import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { createSqliteDialect } from './internal/kysely-sqlite-dialect.js';
import { openLibsqlHandle } from './internal/libsql-handle.js';
import { openNodeSqliteHandle } from './internal/node-sqlite-handle.js';
import { openSqliteHandle, type SqliteHandle } from './internal/sqlite-handle.js';
import { migrateToLatest } from './migration-runner.js';
import { openRunStore, type RunStore } from './run-store.js';

const stores: RunStore[] = [];
const directories: string[] = [];

const temporaryDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-database-'));
  directories.push(directory);
  return join(directory, 'runs.db');
};

interface ReturningDatabase {
  returning_items: { id: number; name: string };
}

/** Verifies that the driver materializes mutation rows instead of discarding them. */
const expectMutationReturning = async (handle: SqliteHandle): Promise<void> => {
  await handle.exec('CREATE TABLE returning_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const database = new Kysely<ReturningDatabase>({ dialect: createSqliteDialect(handle) });
  const row = await database
    .insertInto('returning_items')
    .values({ id: 1, name: 'first' })
    .returning(['id', 'name'])
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ id: 1, name: 'first' });
  await expect(
    database
      .updateTable('returning_items')
      .set({ name: 'updated' })
      .where('id', '=', 1)
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ id: 1, name: 'updated' });
  await expect(
    database
      .deleteFrom('returning_items')
      .where('id', '=', 1)
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ id: 1, name: 'updated' });
  await database.destroy();
};

const isLibsqlUnavailable = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED';
};

/** Runs a Node subprocess and resolves with its intentional crash exit code. */
const runCrashWriter = async (
  databasePath: string,
): Promise<{ code: number; standardError: string; standardOutput: string }> => {
  const loaderPath = fileURLToPath(
    new URL('./test-fixtures/typescript-loader.mjs', import.meta.url),
  );
  const writerPath = fileURLToPath(new URL('./test-fixtures/crash-writer.ts', import.meta.url));

  return new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--experimental-loader', loaderPath, writerPath, databasePath],
      { cwd: dirname(databasePath) },
    );
    let standardError = '';
    let standardOutput = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      standardError += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      standardOutput += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === null) {
        reject(new Error(`Crash writer was terminated by a signal: ${standardError}`));
        return;
      }
      resolveExit({ code, standardError, standardOutput });
    });
  });
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('SQLite store database', () => {
  it('applies migrations idempotently across reopen', async () => {
    const path = await temporaryDatabasePath();
    const first = await openRunStore(path);
    await first.close();

    const second = await openRunStore(path);
    stores.push(second);
    const handle = await openSqliteHandle(path);
    const rows = await handle.prepare('SELECT version, name FROM schema_migrations').all();
    await handle.close();

    expect(rows).toEqual([{ version: 1, name: 'schema_v1' }]);
  });

  it('serializes concurrent open and migration for one resolved path', async () => {
    const path = await temporaryDatabasePath();
    const [first, second] = await Promise.all([openRunStore(path), openRunStore(path)]);
    stores.push(first, second);

    const handle = await openSqliteHandle(path);
    const rows = await handle.prepare('SELECT version FROM schema_migrations').all();
    await handle.close();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it('rejects a schema version newer than this attest build', async () => {
    const path = await temporaryDatabasePath();
    const handle = await openSqliteHandle(path);
    await migrateToLatest(handle);
    await handle
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(999, 'future', '2026-08-06T00:00:00.000Z');
    await handle.close();

    await expect(openRunStore(path)).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
  });

  it('rolls back all schema changes when a migration fails partway', async () => {
    const path = await temporaryDatabasePath();
    const handle = await openSqliteHandle(path);
    const failingHandle: SqliteHandle = {
      ...handle,
      exec: async (sql) => {
        await handle.exec(sql);
        if (sql.includes('CREATE TABLE runs')) {
          throw new Error('injected migration failure');
        }
      },
    };

    await expect(migrateToLatest(failingHandle)).rejects.toThrow('injected migration failure');
    expect(
      await handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
        .all(),
    ).toEqual([]);
    expect(await handle.prepare('SELECT version FROM schema_migrations').all()).toEqual([]);
    await handle.close();
  });

  it('recovers a run and case after a child process exits without close', async () => {
    const path = await temporaryDatabasePath();
    const result = await runCrashWriter(path);
    expect(result.code).toBe(1);
    expect(result.standardError).not.toContain('Error');
    const runId = result.standardOutput;

    const reopened = await openRunStore(path);
    stores.push(reopened);
    await expect(reopened.getRun(runId)).resolves.toMatchObject({ id: runId, status: 'running' });
    await expect(reopened.getCaseResults(runId)).resolves.toMatchObject([
      { caseId: 'crash-case', runId },
    ]);
  });

  it('enables WAL journal mode', async () => {
    const path = await temporaryDatabasePath();
    const handle = await openSqliteHandle(path);
    const [row] = await handle.prepare('PRAGMA journal_mode').all();
    await handle.close();

    expect((row as { journal_mode: string }).journal_mode).toBe('wal');
  });

  it('returns inserted rows through the node:sqlite handle', async ({ skip }) => {
    const path = await temporaryDatabasePath();
    const handle = await openNodeSqliteHandle(path);
    if (!handle) {
      skip();
      return;
    }
    await expectMutationReturning(handle);
  });

  it('runs WAL, transactions, rollback, and RETURNING through forced libsql', async ({ skip }) => {
    const path = await temporaryDatabasePath();
    let handle: SqliteHandle;
    try {
      handle = await openLibsqlHandle(path);
    } catch (error) {
      if (isLibsqlUnavailable(error)) {
        skip();
        return;
      }
      throw error;
    }

    await handle.exec('PRAGMA journal_mode=WAL');
    await migrateToLatest(handle);
    expect(await handle.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 },
    ]);
    await handle.exec('CREATE TABLE transaction_items (id INTEGER PRIMARY KEY)');
    await handle.begin();
    await handle.prepare('INSERT INTO transaction_items (id) VALUES (?)').run(1);
    await handle.commit();
    await handle.begin();
    await handle.prepare('INSERT INTO transaction_items (id) VALUES (?)').run(2);
    await handle.rollback();
    expect(await handle.prepare('SELECT id FROM transaction_items').all()).toEqual([{ id: 1 }]);
    expect(
      ((await handle.prepare('PRAGMA journal_mode').all())[0] as { journal_mode: string })
        .journal_mode,
    ).toBe('wal');
    await expectMutationReturning(handle);
  });
});
