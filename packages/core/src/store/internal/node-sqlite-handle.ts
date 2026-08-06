import type { SqliteHandle } from '../database.js';

/** Opens node:sqlite lazily so unsupported Node runtimes can use the libsql fallback. */
const openNodeSqliteHandle = async (path: string): Promise<SqliteHandle | undefined> => {
  let sqliteModule: typeof import('node:sqlite');
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    return undefined;
  }

  const database = new sqliteModule.DatabaseSync(path);
  return {
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        all: async (...parameters) => statement.all(...(parameters as never[])),
        run: async (...parameters) => statement.run(...(parameters as never[])),
      };
    },
    exec: async (sql) => database.exec(sql),
    begin: async () => database.exec('BEGIN IMMEDIATE'),
    commit: async () => database.exec('COMMIT'),
    rollback: async () => database.exec('ROLLBACK'),
    close: async () => database.close(),
  };
};

export { openNodeSqliteHandle };
