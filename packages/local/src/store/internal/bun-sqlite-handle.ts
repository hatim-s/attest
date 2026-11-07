import type { SqliteHandle } from './sqlite-handle.js';

/** Owns native Bun statements because its node:sqlite wrapper cannot finalize them on close. */
const openBunSqliteHandle = async (
  path: string,
  options: { readOnly?: boolean } = {},
): Promise<SqliteHandle> => {
  const { Database } = await import('bun:sqlite');
  const database = new Database(path, { readonly: options.readOnly, create: !options.readOnly });
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
