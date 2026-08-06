import {
  DeleteQueryNode,
  InsertQueryNode,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  UpdateQueryNode,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type OperationNode,
  type QueryResult,
} from 'kysely';

import { ConnectionMutex } from './internal/connection-mutex.js';
import { openLibsqlHandle } from './internal/libsql-handle.js';
import { openNodeSqliteHandle } from './internal/node-sqlite-handle.js';

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

const applyPragmas = async (handle: SqliteHandle): Promise<void> => {
  await handle.exec('PRAGMA journal_mode=WAL');
  await handle.exec('PRAGMA busy_timeout=5000');
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

const returnsRows = (node: OperationNode): boolean =>
  SelectQueryNode.is(node) ||
  (InsertQueryNode.is(node) && node.returning !== undefined) ||
  (UpdateQueryNode.is(node) && node.returning !== undefined) ||
  (DeleteQueryNode.is(node) && node.returning !== undefined);

class HandleConnection implements DatabaseConnection {
  readonly #handle: SqliteHandle;

  constructor(handle: SqliteHandle) {
    this.#handle = handle;
  }

  /** Executes row-returning mutations through the same materialization path as selects. */
  async executeQuery<Row>(compiledQuery: CompiledQuery): Promise<QueryResult<Row>> {
    const statement = this.#handle.prepare(compiledQuery.sql);
    if (returnsRows(compiledQuery.query)) {
      const rows = await statement.all(...compiledQuery.parameters);
      return { rows: rows as Row[] };
    }

    const result = await statement.run(...compiledQuery.parameters);
    return { numAffectedRows: BigInt(result.changes), rows: [] };
  }

  /** Streams the single materialized select result produced by the portable handle. */
  async *streamQuery<Row>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<Row>> {
    if (!SelectQueryNode.is(compiledQuery.query)) {
      throw new TypeError('SQLite streaming is only supported for select queries.');
    }

    yield await this.executeQuery<Row>(compiledQuery);
  }
}

class HandleDriver implements Driver {
  readonly #connection: HandleConnection;
  readonly #handle: SqliteHandle;
  readonly #mutex = new ConnectionMutex();

  constructor(handle: SqliteHandle) {
    this.#handle = handle;
    this.#connection = new HandleConnection(handle);
  }

  async init(): Promise<void> {}

  /**
   * SQLite has one writer and this driver has one shared connection, so exclusivity must live here
   * to bracket both standalone queries and complete Kysely transactions.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.acquire();
    return this.#connection;
  }

  async beginTransaction(): Promise<void> {
    await this.#handle.begin();
  }

  async commitTransaction(): Promise<void> {
    await this.#handle.commit();
  }

  async rollbackTransaction(): Promise<void> {
    await this.#handle.rollback();
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.release();
  }

  async destroy(): Promise<void> {
    await this.#handle.close();
  }
}

/** Adapts the portable handle while retaining Kysely's SQLite compiler stack. */
const createSqliteDialect = (handle: SqliteHandle): Dialect => ({
  createAdapter: () => new SqliteAdapter(),
  createDriver: () => new HandleDriver(handle),
  createIntrospector: (database: Kysely<unknown>) => new SqliteIntrospector(database),
  createQueryCompiler: () => new SqliteQueryCompiler(),
});

export { createSqliteDialect, openSqliteHandle, type SqliteHandle, type SqliteStatement };
