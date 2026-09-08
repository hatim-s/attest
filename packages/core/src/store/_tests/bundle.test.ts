import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { AGENT_PROTOCOL } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLE_SCHEMA_ID, createContentHasher } from '../bundle-format.js';
import { exportRunBundle, readRunBundle } from '../bundle-io.js';
import { canonicalStringify } from '../internal/canonical-json.js';
import { openStore, type RunStore } from '../run-store.js';

const stores: RunStore[] = [];
const directories: string[] = [];

const openTemporaryStore = async (): Promise<{ directory: string; store: RunStore }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-bundle-'));
  const store = (await openStore(join(directory, 'runs.db'))).runs;
  directories.push(directory);
  stores.push(store);
  return { directory, store };
};

/** Creates one completed run whose exported case exercises the structural bundle guard. */
const createStoredRun = async (store: RunStore) => {
  const run = await store.createRun({
    schemaId: 'attest.project',
    configHash: 'hash',
    configJson: '{}',
  });
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

/** Rehashes a deliberately malformed recognized record so structural checks are isolated. */
const mutateAndRehashBundle = async (
  destination: string,
  mutate: (header: Record<string, unknown>, caseLine: Record<string, unknown>) => void,
): Promise<Readable> => {
  const originalLines = (await readFile(destination, 'utf8')).trimEnd().split('\n');
  const header = JSON.parse(originalLines[0] ?? '') as Record<string, unknown>;
  const caseLine = JSON.parse(originalLines[1] ?? '') as Record<string, unknown>;
  mutate(header, caseLine);
  const contentLines = [canonicalStringify(header), canonicalStringify(caseLine)];
  const hasher = createContentHasher();
  for (const line of contentLines) hasher.add(line);
  const footer = canonicalStringify({
    type: 'bundle_footer',
    case_count: 1,
    content_hash: hasher.digest(),
  });
  return Readable.from(`${[...contentLines, footer].join('\n')}\n`);
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('run bundles', () => {
  it('round-trips a structurally verified run and case', async () => {
    expect(BUNDLE_SCHEMA_ID).toBe('attest.bundle');
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'run.ndjson');
    const manifest = await exportRunBundle(store, run.id, destination);
    await expect(collect(destination)).resolves.toMatchObject([
      { type: 'bundle_header', schema: BUNDLE_SCHEMA_ID, run: { id: run.id } },
      { type: 'case', case: { caseId: 'case-1' } },
      { type: 'bundle_footer', content_hash: manifest.contentHash },
    ]);
    expect(manifest.schemaId).toBe(BUNDLE_SCHEMA_ID);
  });

  it('rejects a destination closed during backpressure without hanging the export', async () => {
    const { store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = new Writable({
      highWaterMark: 1,
      write() {
        this.destroy();
      },
    });

    const result = await Promise.race([
      exportRunBundle(store, run.id, destination).catch((error: unknown) => error),
      delay(100).then(() => 'export did not settle'),
    ]);

    expect(result).toMatchObject({ code: 'WRITE_FAILED' });
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

  it('rejects unknown line types even when the bundle hash is valid', async () => {
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

    await expect(
      collect(Readable.from(`${[...contentLines, footer].join('\n')}\n`)),
    ).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
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

  it('reports an unsupported bundle schema separately from malformed headers', async () => {
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'unsupported-schema.ndjson');
    await exportRunBundle(store, run.id, destination);
    const source = await mutateAndRehashBundle(destination, (header) => {
      header.schema = 'attest.bundle/future';
    });

    await expect(collect(source)).rejects.toThrow(
      'Run bundle header uses unsupported schema "attest.bundle/future"',
    );
  });

  it('reports field-level violations for malformed header runs', async () => {
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'malformed-run.ndjson');
    await exportRunBundle(store, run.id, destination);
    const source = await mutateAndRehashBundle(destination, (header) => {
      (header.run as Record<string, unknown>).status = 'other';
    });

    await expect(collect(source)).rejects.toThrow(
      'Run bundle header contains a malformed run: header.run.status',
    );
  });

  it.each([
    [
      'invalid run status',
      (header: Record<string, unknown>) => {
        (header.run as Record<string, unknown>).status = 'other';
      },
    ],
    [
      'invalid run timestamp',
      (header: Record<string, unknown>) => {
        (header.run as Record<string, unknown>).finishedAt = 'yesterday';
      },
    ],
    [
      'foreign case run id',
      (_header: Record<string, unknown>, caseLine: Record<string, unknown>) => {
        (caseLine.case as Record<string, unknown>).runId = 'other-run';
      },
    ],
    [
      'completed case error field',
      (_header: Record<string, unknown>, caseLine: Record<string, unknown>) => {
        (caseLine.case as Record<string, unknown>).errorMessage = 'forbidden';
      },
    ],
    [
      'malformed evaluated metric',
      (_header: Record<string, unknown>, caseLine: Record<string, unknown>) => {
        const caseRecord = caseLine.case as Record<string, unknown>;
        const metrics = caseRecord.metrics as Array<Record<string, unknown>>;
        delete metrics[0]?.pass;
      },
    ],
  ] as const)('rejects a self-hashed bundle with %s', async (_, mutate) => {
    const { directory, store } = await openTemporaryStore();
    const run = await createStoredRun(store);
    const destination = join(directory, 'structurally-invalid.ndjson');
    await exportRunBundle(store, run.id, destination);
    const source = await mutateAndRehashBundle(destination, mutate);
    await expect(collect(source)).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
  });
});
