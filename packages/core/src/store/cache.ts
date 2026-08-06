import type { Kysely } from 'kysely';

import { canonicalStringify } from './internal/canonical-json.js';
import { executeStoreOperation } from './internal/store-operation.js';
import type { Database } from './schema.js';
import { StoreError } from './types.js';

type CacheKind = 'agent' | 'judge';

/** Defines response-cache lookup and insertion for PLAN 1D.4. */
interface CacheStore {
  /** Returns the cached JSON value, or `undefined` when the identity is absent. */
  get(kind: CacheKind, requestHash: string): Promise<unknown>;
  put(kind: CacheKind, requestHash: string, payload: unknown): Promise<void>;
}

const nextUseTimestamp = (previousTimestamp: string): string => {
  const previousTime = Date.parse(previousTimestamp);
  // A monotonic value makes consecutive cache hits observable even within one wall-clock millisecond.
  return new Date(Math.max(Date.now(), previousTime + 1)).toISOString();
};

class SqliteCacheStore implements CacheStore {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  /** Reads and touches one cache identity; a miss deliberately resolves to `undefined`. */
  async get(kind: CacheKind, requestHash: string): Promise<unknown> {
    return executeStoreOperation('READ_FAILED', 'Could not read the response cache.', async () =>
      this.#database.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom('response_cache')
          .select(['payload_json', 'last_used_at'])
          .where('cache_key', '=', requestHash)
          .where('kind', '=', kind)
          .executeTakeFirst();
        if (!row) return undefined;

        await transaction
          .updateTable('response_cache')
          .set({ last_used_at: nextUseTimestamp(row.last_used_at) })
          .where('cache_key', '=', requestHash)
          .where('kind', '=', kind)
          .execute();
        try {
          return JSON.parse(row.payload_json) as unknown;
        } catch (error) {
          throw new StoreError('CORRUPT_DATA', 'Cached response JSON could not be rehydrated.', {
            cause: error,
          });
        }
      }),
    );
  }

  /** Upserts one immutable request identity while retaining its original creation timestamp. */
  async put(kind: CacheKind, requestHash: string, payload: unknown): Promise<void> {
    await executeStoreOperation('WRITE_FAILED', 'Could not write the response cache.', async () => {
      const timestamp = new Date().toISOString();
      const payloadJson = canonicalStringify(payload);
      await this.#database
        .insertInto('response_cache')
        .values({
          cache_key: requestHash,
          kind,
          payload_json: payloadJson,
          created_at: timestamp,
          last_used_at: timestamp,
        })
        .onConflict((conflict) =>
          conflict.columns(['kind', 'cache_key']).doUpdateSet({
            payload_json: payloadJson,
            last_used_at: timestamp,
          }),
        )
        .execute();
    });
  }
}

/** Constructs a cache over the database explicitly owned by an AttestStore context. */
const createCacheStore = (database: Kysely<Database>): CacheStore => new SqliteCacheStore(database);

export { createCacheStore, type CacheKind, type CacheStore };
