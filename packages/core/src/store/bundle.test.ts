import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { AGENT_PROTOCOL } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createContentHasher } from './bundle-format.js';
import { exportRunBundle, readRunBundle } from './bundle-io.js';
import { canonicalStringify } from './internal/canonical-json.js';
import { openRunStore, type RunStore } from './run-store.js';

const stores: RunStore[] = [];
const directories: string[] = [];

const openTemporaryStore = async (): Promise<{ directory: string; store: RunStore }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-bundle-'));
  const store = await openRunStore(join(directory, 'runs.db'));
  directories.push(directory);
  stores.push(store);
  return { directory, store };
};

/** Creates one completed run whose exported case exercises the structural bundle guard. */
const createStoredRun = async (store: RunStore) => {
  const run = await store.createRun({ configVersion: 'v1', configHash: 'hash', configJson: '{}' });
  await store.recordCase(
    run.id,
    {
      caseId: 'case-1',
      suiteName: 'suite',
      outcome: 'completed',
      startedAt: '2026-08-06T00:00:00.000Z',
      durationMs: 12,
      request: { protocol: AGENT_PROTOCOL, run_id: run.id, case_id: 'case-1', input: {} },
      response: { output: 'ok' },
      warnings: [],
      diagnostics: {},
      attempts: [],
      expectedMetrics: ['quality'],
    },
    [{ metricName: 'quality', kind: 'assertion', status: 'evaluated', score: 1, pass: true }],
  );
  return store.finalizeRun(run.id, 'completed');
};

const collect = async (source: Readable | string) => {
  const records = [];
  for await (const record of readRunBundle(source)) records.push(record);
  return records;
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('run bundles', () => {
  it('round-trips a structurally verified run and case', async () => {
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'run.ndjson');
    const manifest = await exportRunBundle(store, run.id, destination);
    await expect(collect(destination)).resolves.toMatchObject([
      { type: 'bundle_header', run: { id: run.id } },
      { type: 'case', case: { caseId: 'case-1' } },
      { type: 'bundle_footer', content_hash: manifest.contentHash },
    ]);
  });

  it('rejects a tampered case before yielding any record', async () => {
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'tampered.ndjson');
    await exportRunBundle(store, run.id, destination);
    const contents = await readFile(destination, 'utf8');
    await writeFile(destination, contents.replace('"output":"ok"', '"output":"no"'), 'utf8');
    let yielded = 0;
    const failure = await (async () => {
      for await (const record of readRunBundle(destination)) {
        yielded += 1;
        void record;
      }
    })().catch((error: unknown) => error);
    expect(yielded).toBe(0);
    expect(failure).toMatchObject({ code: 'CORRUPT_DATA' });
  });

  it('rejects a footer-only bundle even when its empty hash is valid', async () => {
    const hasher = createContentHasher();
    const footer = canonicalStringify({
      type: 'bundle_footer',
      case_count: 0,
      content_hash: hasher.digest(),
    });
    await expect(collect(Readable.from(`${footer}\n`))).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
  });

  it('hash-covers and skips unknown line types from a valid bundle', async () => {
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'unknown.ndjson');
    await exportRunBundle(store, run.id, destination);
    const lines = (await readFile(destination, 'utf8')).trimEnd().split('\n');
    const unknown = canonicalStringify({ type: 'future_optional', value: { retained: true } });
    const contentLines = [lines[0] ?? '', unknown, lines[1] ?? ''];
    const hasher = createContentHasher();
    for (const line of contentLines) hasher.add(line);
    const footer = canonicalStringify({
      type: 'bundle_footer',
      case_count: 1,
      content_hash: hasher.digest(),
    });

    const records = await collect(Readable.from(`${[...contentLines, footer].join('\n')}\n`));
    expect(records.map((record) => record.type)).toEqual([
      'bundle_header',
      'case',
      'bundle_footer',
    ]);
  });

  it('rejects a case-count mismatch even when the footer hash is valid', async () => {
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'mismatched-count.ndjson');
    await exportRunBundle(store, run.id, destination);
    const lines = (await readFile(destination, 'utf8')).trimEnd().split('\n');
    const contentLines = lines.slice(0, -1);
    const hasher = createContentHasher();
    for (const line of contentLines) hasher.add(line);
    const footer = canonicalStringify({
      type: 'bundle_footer',
      case_count: 2,
      content_hash: hasher.digest(),
    });
    await expect(
      collect(Readable.from(`${[...contentLines, footer].join('\n')}\n`)),
    ).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
  });
});
