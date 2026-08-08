import { openLibsqlHandle } from './libsql-handle.js';
import { openNodeSqliteHandle } from './node-sqlite-handle.js';

/** Minimal statement surface shared by node:sqlite and the libsql fallback (PLAN 1S.1). */
interface SqliteStatement {
  all(...parameters: unknown[]): Promise<unknown[]>;
  run(...parameters: unknown[]): Promise<{ changes: number | bigint }>;
}

/** Minimal transaction-capable database surface used by migrations and the Kysely driver. */
interface SqliteHandle {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

/** Applies cross-process contention handling before any lock-sensitive store pragma. */
const applyPragmas = async (handle: SqliteHandle): Promise<void> => {
  // Another process may already hold the WAL transition lock, so the timeout must be installed first.
  await handle.exec('PRAGMA busy_timeout=5000');
  await handle.exec('PRAGMA journal_mode=WAL');
  await handle.exec('PRAGMA foreign_keys=ON');
  await handle.exec('PRAGMA synchronous=NORMAL');
};

/** Opens the preferred local SQLite implementation and applies durability pragmas. */
const openSqliteHandle = async (path: string): Promise<SqliteHandle> => {
  const nodeHandle = await openNodeSqliteHandle(path);
  const handle = nodeHandle ?? (await openLibsqlHandle(path));
  try {
    await applyPragmas(handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

/** Opens an existing database without migrations, write pragmas, or a creating fallback. */
const openReadonlySqliteHandle = async (path: string): Promise<SqliteHandle> => {
  const handle = await openNodeSqliteHandle(path, { readOnly: true });
  if (!handle) {
    throw new Error('Read-only run-store inspection requires node:sqlite support.');
  }
  return handle;
};

/** Opens a disposable copied database read-only while allowing SQLite to consume its copied WAL. */
const openSnapshotSqliteHandle = async (path: string): Promise<SqliteHandle> => {
  const handle = await openNodeSqliteHandle(path, { immutable: false, readOnly: true });
  if (!handle) {
    throw new Error('Run-store snapshot inspection requires node:sqlite support.');
  }
  return handle;
};

export {
  openReadonlySqliteHandle,
  openSnapshotSqliteHandle,
  openSqliteHandle,
  type SqliteHandle,
  type SqliteStatement,
};
