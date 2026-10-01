type SqliteValue = null | string | number | bigint | Uint8Array;

/** Minimal prepared statement interface shared by the supported SQLite drivers. */
interface SqliteStatement {
  all(...parameters: SqliteValue[]): Promise<unknown[]>;
  run(...parameters: SqliteValue[]): Promise<{ changes: number | bigint }>;
}

/** Minimal transaction interface required by migrations and Kysely. */
interface SqliteHandle {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export { type SqliteHandle, type SqliteStatement, type SqliteValue };
