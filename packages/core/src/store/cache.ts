type CacheKind = 'agent' | 'judge';

/** Stores content-addressed execution results without prescribing a database. */
interface CacheStore {
  get(kind: CacheKind, requestHash: string): Promise<unknown>;
  put(kind: CacheKind, requestHash: string, payload: unknown): Promise<void>;
}

export { type CacheKind, type CacheStore };
