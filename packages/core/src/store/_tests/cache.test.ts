import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteHandle } from '../internal/sqlite-handle.js';
import { openStore } from '../run-store.js';
import type { AttestStore } from '../types.js';

const stores: AttestStore[] = [];
const directories: string[] = [];

const openTemporaryStore = async (): Promise<{ path: string; store: AttestStore }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-cache-'));
  const path = join(directory, 'runs.db');
  const store = await openStore(path);
  stores.push(store);
  directories.push(directory);
  return { path, store };
};

const readLastUsedAt = async (path: string, requestHash: string): Promise<string> => {
  const handle = await openSqliteHandle(path);
  const [row] = (await handle
    .prepare('SELECT last_used_at FROM response_cache WHERE cache_key = ?')
    .all(requestHash)) as { last_used_at: string }[];
  await handle.close();
  return row?.last_used_at ?? '';
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('CacheStore', () => {
  it('round-trips kind-isolated canonical payloads and returns undefined for misses', async () => {
    const { store } = await openTemporaryStore();
    expect(await store.cache.get('judge', 'missing')).toBeUndefined();
    await store.cache.put('agent', 'shared', { answer: 'agent' });
    await store.cache.put('judge', 'shared', { score: 0.8 });
    expect(await store.cache.get('agent', 'shared')).toEqual({ answer: 'agent' });
    expect(await store.cache.get('judge', 'shared')).toEqual({ score: 0.8 });
  });

  it('bumps last_used_at monotonically on a cache hit', async () => {
    const { path, store } = await openTemporaryStore();
    await store.cache.put('judge', 'request-hash', { score: 1 });
    const before = await readLastUsedAt(path, 'request-hash');
    await store.cache.get('judge', 'request-hash');
    expect(Date.parse(await readLastUsedAt(path, 'request-hash'))).toBeGreaterThan(
      Date.parse(before),
    );
  });
});
