import type { Client, InArgs, Transaction } from '@libsql/client';

import type { SqliteHandle } from '../database.js';

/** Executes a migration script statement-by-statement on the active interactive transaction. */
const executeTransactionScript = async (transaction: Transaction, sql: string): Promise<void> => {
  // Migration sources are controlled schema scripts whose statements do not contain semicolons in values.
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await transaction.execute(statement);
  }
};

/** Creates a libsql handle whose active transaction becomes the route for every operation. */
const createLibsqlHandle = (client: Client): SqliteHandle => {
  let activeTransaction: Transaction | undefined;

  const execute = async (sql: string, parameters: unknown[] = []) => {
    const route = activeTransaction ?? client;
    return route.execute({ sql, args: parameters as InArgs });
  };

  return {
    prepare: (sql) => ({
      all: async (...parameters) => (await execute(sql, parameters)).rows as unknown[],
      run: async (...parameters) => ({ changes: (await execute(sql, parameters)).rowsAffected }),
    }),
    exec: async (sql) => {
      if (activeTransaction) {
        await executeTransactionScript(activeTransaction, sql);
        return;
      }

      await client.executeMultiple(sql);
    },
    begin: async () => {
      if (activeTransaction) {
        throw new Error('A libsql transaction is already active.');
      }

      activeTransaction = await client.transaction('write');
    },
    commit: async () => {
      if (!activeTransaction) {
        throw new Error('No libsql transaction is active.');
      }

      const transaction = activeTransaction;
      try {
        await transaction.commit();
      } finally {
        activeTransaction = undefined;
      }
    },
    rollback: async () => {
      if (!activeTransaction) {
        throw new Error('No libsql transaction is active.');
      }

      const transaction = activeTransaction;
      try {
        await transaction.rollback();
      } finally {
        activeTransaction = undefined;
      }
    },
    close: async () => {
      if (activeTransaction) {
        try {
          await activeTransaction.rollback();
        } finally {
          activeTransaction = undefined;
        }
      }
      client.close();
    },
  };
};

/** Opens the portable local libsql implementation directly for fallback verification. */
const openLibsqlHandle = async (path: string): Promise<SqliteHandle> => {
  const { createClient } = await import('@libsql/client');
  return createLibsqlHandle(createClient({ url: `file:${path}`, timeout: 5_000 }));
};

export { createLibsqlHandle, openLibsqlHandle };
