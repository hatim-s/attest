import type { SqliteHandle } from './sqlite-handle.js';

/** Owns native Bun statements because its node:sqlite wrapper cannot finalize them on close. */
const openBunSqliteHandle = async (
  path: string,
  options: { readOnly?: boolean } = {},
): Promise<SqliteHandle> => {
  const { Database, constants } = await import('bun:sqlite');
  const database = new Database(path, { readonly: options.readOnly, create: !options.readOnly });
  // macOS SQLite persists empty WAL sidecars by default. Let SQLite remove them on final writable close.
  const status = database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);

  if (status !== 0) {
    database.close(true);
    throw new Error(`Could not disable persistent Bun SQLite WAL: ${status}.`);
  }

  const statements = new Set<ReturnType<typeof database.prepare>>();

  return {
    prepare: (sql) => {
      const statement = database.prepare(sql);
      statements.add(statement);

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
    close: () =>
      Promise.resolve().then(() => {
        const failures: unknown[] = [];

        // Attempt every release even if one statement fails to finalize.
        for (const statement of statements) {
          try {
            statement.finalize();
          } catch (cause) {
            failures.push(cause);
          }
        }

        statements.clear();

        if (!options.readOnly) {
          try {
            // A standalone readonly copy also needs a rollback-journal header on macOS SQLite.
            database.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE');
          } catch (cause) {
            // Another connection can retain WAL mode. SQLite retains its sidecars until a writable close can remove them.
            if (!(cause instanceof Error && 'code' in cause && cause.code === 'SQLITE_BUSY'))
              failures.push(cause);
          }
        }

        try {
          // Strict close confirms SQLite has released the connection and checkpointed its WAL.
          database.close(true);
        } catch (cause) {
          failures.push(cause);
        }

        if (failures.length > 0) throw new AggregateError(failures, 'Could not close Bun SQLite.');
      }),
  };
};

export { openBunSqliteHandle };
