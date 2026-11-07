import { run as runEffect, openFixture } from './store-fixture.js';
import * as Effect from 'effect/Effect';
import { valueFromExit } from '../../internal/effect-exit.js';
import { stripStruct } from '@attest/contracts';
import { parseWithSchemaSync } from '@attest/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as Schema from 'effect/Schema';
import type { AttestStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteHandle } from '../internal/open-sqlite-handle.js';

const stores: { close(): Promise<void> }[] = [];

const directories: string[] = [];

const openTemporaryStore = async (): Promise<{ path: string; store: AttestStore }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-cache-'));
  const path = join(directory, 'runs.db');
  const fixture = await openFixture(path);
  const store = fixture.store;
  stores.push(fixture);
  directories.push(directory);

  return { path, store };
};

const readLastUsedAt = async (path: string, requestHash: string): Promise<string> => {
  const handle = valueFromExit(await Effect.runPromiseExit(openSqliteHandle(path)));

  const [row] = parseWithSchemaSync(
    Schema.Array(stripStruct({ last_used_at: Schema.String })),
    await handle
      .prepare('SELECT last_used_at FROM response_cache WHERE cache_key = ?')
      .all(requestHash),
  );

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
    expect(await runEffect(store.cache.get('judge', 'missing'))).toBeUndefined();
    await runEffect(store.cache.put('agent', 'shared', { answer: 'agent' }));
    await runEffect(store.cache.put('judge', 'shared', { score: 0.8 }));
    expect(await runEffect(store.cache.get('agent', 'shared'))).toEqual({ answer: 'agent' });
    expect(await runEffect(store.cache.get('judge', 'shared'))).toEqual({ score: 0.8 });
  });

  it('bumps last_used_at monotonically on a cache hit', async () => {
    const { path, store } = await openTemporaryStore();
    await runEffect(store.cache.put('judge', 'request-hash', { score: 1 }));
    const before = await readLastUsedAt(path, 'request-hash');
    await runEffect(store.cache.get('judge', 'request-hash'));
    expect(Date.parse(await readLastUsedAt(path, 'request-hash'))).toBeGreaterThan(
      Date.parse(before),
    );
  });
});
