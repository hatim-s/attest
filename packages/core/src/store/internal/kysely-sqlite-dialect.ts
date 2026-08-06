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

import { StoreError } from '../types.js';
import { createLock } from './promise-lock.js';
import type { SqliteHandle } from './sqlite-handle.js';

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
      throw new StoreError('DRIVER_MISUSE', 'SQLite streaming only supports select queries.');
    }

    yield await this.executeQuery<Row>(compiledQuery);
  }
}

class HandleDriver implements Driver {
  readonly #connection: HandleConnection;
  readonly #handle: SqliteHandle;
  readonly #lock = createLock();
  #releaseConnection: (() => void) | undefined;

  constructor(handle: SqliteHandle) {
    this.#handle = handle;
    this.#connection = new HandleConnection(handle);
  }

  async init(): Promise<void> {}

  /** Brackets both standalone statements and complete Kysely transactions on one connection. */
  async acquireConnection(): Promise<DatabaseConnection> {
    this.#releaseConnection = await this.#lock.acquire();
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
    const release = this.#releaseConnection;
    if (!release) {
      throw new StoreError('DRIVER_MISUSE', 'Cannot release an unacquired SQLite connection.');
    }
    this.#releaseConnection = undefined;
    release();
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

export { createSqliteDialect };
