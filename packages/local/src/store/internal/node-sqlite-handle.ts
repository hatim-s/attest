import { openBunSqliteHandle } from './bun-sqlite-handle.js';
import type { SqliteHandle } from './sqlite-handle.js';

interface NodeSqliteHandleOptions {
  readOnly?: boolean;
}

/** Opens node:sqlite lazily so unsupported Node runtimes can use the libsql fallback. */
const openNodeSqliteHandle = async (
  path: string,
  options: NodeSqliteHandleOptions = {},
): Promise<SqliteHandle | undefined> => {
  if (process.versions.bun !== undefined) return openBunSqliteHandle(path, options);

  let sqliteModule: typeof import('node:sqlite');

  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    return undefined;
  }

  const database = new sqliteModule.DatabaseSync(path, { readOnly: options.readOnly });

  return {
    prepare: (sql) => {
      const statement = database.prepare(sql);

      return {
        all: (...parameters) => Promise.resolve().then(() => statement.all(...parameters)),
        run: (...parameters) => Promise.resolve().then(() => statement.run(...parameters)),
      };
    },
    exec: (sql) => Promise.resolve().then(() => database.exec(sql)),
    begin: (mode) =>
      Promise.resolve().then(() => database.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE')),
    commit: () => Promise.resolve().then(() => database.exec('COMMIT')),
    rollback: () => Promise.resolve().then(() => database.exec('ROLLBACK')),
    close: () => Promise.resolve().then(() => database.close()),
  };
};

export { openNodeSqliteHandle };
