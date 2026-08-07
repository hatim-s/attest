import { pathToFileURL } from 'node:url';

import type { SqliteHandle } from './sqlite-handle.js';

interface NodeSqliteHandleOptions {
  readOnly?: boolean;
}

/** Opens node:sqlite lazily so unsupported Node runtimes can use the libsql fallback. */
const openNodeSqliteHandle = async (
  path: string,
  options: NodeSqliteHandleOptions = {},
): Promise<SqliteHandle | undefined> => {
  let sqliteModule: typeof import('node:sqlite');
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    return undefined;
  }

  // SQLite otherwise creates WAL bookkeeping sidecars even for a read-only connection.
  const location = options.readOnly ? `${pathToFileURL(path).href}?immutable=1` : path;
  const database = new sqliteModule.DatabaseSync(location, { readOnly: options.readOnly });
  return {
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        all: (...parameters) =>
          Promise.resolve().then(() => statement.all(...(parameters as never[]))),
        run: (...parameters) =>
          Promise.resolve().then(() => statement.run(...(parameters as never[]))),
      };
    },
    exec: (sql) => Promise.resolve().then(() => database.exec(sql)),
    begin: () => Promise.resolve().then(() => database.exec('BEGIN IMMEDIATE')),
    commit: () => Promise.resolve().then(() => database.exec('COMMIT')),
    rollback: () => Promise.resolve().then(() => database.exec('ROLLBACK')),
    close: () => Promise.resolve().then(() => database.close()),
  };
};

export { openNodeSqliteHandle, type NodeSqliteHandleOptions };
