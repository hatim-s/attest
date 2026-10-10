import type { JsonValue } from '@attest/contracts';

type CacheKind = 'agent' | 'judge';

/** Stores content-addressed execution results without prescribing a database. */
interface CacheStore {
  get(kind: CacheKind, requestHash: string): Promise<JsonValue | undefined>;
  put(kind: CacheKind, requestHash: string, payload: JsonValue): Promise<void>;
}

export { type CacheKind, type CacheStore };
