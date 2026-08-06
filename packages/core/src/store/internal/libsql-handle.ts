import type { Client, InArgs, Transaction } from '@libsql/client';

import { StoreError } from '../types.js';
import type { SqliteHandle } from './sqlite-handle.js';

/** Splits controlled migration SQL while retaining trigger bodies as one SQLite statement. */
const splitMigrationStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let buffer = '';
  let insideTrigger = false;
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    buffer += `${line}\n`;
    if (trimmed.startsWith('CREATE TRIGGER')) insideTrigger = true;
    if ((insideTrigger && trimmed === 'END;') || (!insideTrigger && trimmed.endsWith(';'))) {
      statements.push(buffer.trim());
      buffer = '';
      insideTrigger = false;
    }
  }
  if (buffer.trim().length > 0) statements.push(buffer.trim());
  return statements;
};

/** Executes a migration script statement-by-statement on the active interactive transaction. */
const executeTransactionScript = async (transaction: Transaction, sql: string): Promise<void> => {
  const statements = splitMigrationStatements(sql);
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
      all: async (...parameters) => (await execute(sql, parameters)).rows,
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
        throw new StoreError('DRIVER_MISUSE', 'A libsql transaction is already active.');
      }

      activeTransaction = await client.transaction('write');
    },
    commit: async () => {
      if (!activeTransaction) {
        throw new StoreError('DRIVER_MISUSE', 'No libsql transaction is active.');
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
        throw new StoreError('DRIVER_MISUSE', 'No libsql transaction is active.');
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

export { createLibsqlHandle, openLibsqlHandle, splitMigrationStatements };
