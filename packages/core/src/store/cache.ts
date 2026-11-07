import type * as Effect from 'effect/Effect';
import type { StoreError } from './store-error.js';
import type { JsonValue } from '@attest/contracts';

type CacheKind = 'agent' | 'judge';

/** Stores content-addressed execution results without prescribing a database. */
interface CacheStore {
  get(kind: CacheKind, requestHash: string): Effect.Effect<JsonValue | undefined, StoreError>;
  put(kind: CacheKind, requestHash: string, payload: JsonValue): Effect.Effect<void, StoreError>;
}

export { type CacheKind, type CacheStore };
