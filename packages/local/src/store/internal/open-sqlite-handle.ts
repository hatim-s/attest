import { openLibsqlHandle } from './libsql-handle.js';
import { openNodeSqliteHandle } from './node-sqlite-handle.js';
import type { SqliteHandle } from './sqlite-handle.js';

/** Applies the local durability and contention settings before store access. */
const applyPragmas = async (handle: SqliteHandle): Promise<void> => {
  await handle.exec('PRAGMA busy_timeout=5000');
  await handle.exec('PRAGMA journal_mode=WAL');
  await handle.exec('PRAGMA foreign_keys=ON');
  await handle.exec('PRAGMA synchronous=NORMAL');
};

/** Opens the preferred SQLite driver and applies local store pragmas. */
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

/**
 * Opens an existing database read-only, without migrations or a creating fallback. A live
 * writer's WAL stays visible, so SQLite may add `-wal` and `-shm` sidecars beside the file.
 */
const openReadonlySqliteHandle = async (path: string): Promise<SqliteHandle> => {
  const handle = await openNodeSqliteHandle(path, { readOnly: true });

  if (handle === undefined) {
    throw new Error('Read-only run-store access requires node:sqlite support.');
  }

  return handle;
};

export { openReadonlySqliteHandle, openSqliteHandle };
