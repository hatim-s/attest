import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PROTOCOL, evalRunSchema, parseWithSchemaSync } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type StoredCaseExecution, type RunStore } from '@attest/core';
import { openStore, openReadonlyRunStore } from '../run-store.js';
import { openSqliteHandle } from '../internal/open-sqlite-handle.js';
import { migrateToLatest, validateReadableSchema } from '../migration-runner.js';
import { migrations } from '../migrations/registry.js';

const roots: string[] = [];

const stores: RunStore[] = [];

const metadata = { schemaId: 'legacy', configHash: 'hash', configJson: '{}' };

const execution = (
  runId: string,
  caseId: string,
  suiteName = 'eval',
): Extract<StoredCaseExecution, { outcome: 'completed' }> => ({
  caseId,
  suiteName,
  outcome: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 10,
  request: { protocol: AGENT_PROTOCOL, run_id: runId, case_id: caseId, input: {} },
  response: { output: 'ok' },
  warnings: [],
  diagnostics: {},
  attempts: [],
  expectedMetrics: [],
});

const temporaryPath = async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-dashboard-'));
  roots.push(root);

  return join(root, 'runs.db');
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('materialized dashboard', () => {
  it('keeps retries, conflicts, child failure rollback and concurrent writers equivalent to case records', async () => {
    const path = await temporaryPath();
    const a = (await openStore(path)).runs;
    const b = (await openStore(path)).runs;
    stores.push(a, b);
    const run = await a.createRun(metadata);
    const first = execution(run.id, 'a');
    await a.recordCase(run.id, first, []);
    await b.recordCase(run.id, first, []);
    await expect(b.recordCase(run.id, { ...first, durationMs: 11 }, [])).rejects.toMatchObject({
      code: 'CASE_CONFLICT',
    });

    const metric = {
      metricName: 'm',
      status: 'evaluated',
      kind: 'assertion',
      pass: true,
      score: 1,
    };

    await expect(
      a.recordCase(run.id, execution(run.id, 'rollback'), [metric, metric]),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    await Promise.all([
      a.recordCase(run.id, execution(run.id, 'b'), []),
      b.recordCase(run.id, execution(run.id, 'c'), []),
    ]);
    const finalized = await a.finalizeRun(run.id, 'completed');
    expect(finalized.summary).toMatchObject({ totalCases: 3, passedCases: 3 });
    expect((await a.listRunSuites(run.id))[0]?.counts.recorded).toBe(3);
    expect((await a.getEvalCaseWindow('eval')).items.map((row) => row.caseId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const reader = await openReadonlyRunStore(path);
    stores.push(reader);
    expect((await reader.listEvals()).items[0]?.latestComplete).toBeNull();
    expect((await reader.getCaseHistory('eval', 'a')).items).toHaveLength(1);
  });

  it('pages equal timestamps and case identities before loading a bounded outcome window', async () => {
    const store = (await openStore(await temporaryPath())).runs;
    stores.push(store);

    for (const id of [
      '01K00000000000000000000001',
      '01K00000000000000000000002',
      '01K00000000000000000000003',
    ]) {
      await store.createRun(metadata, { id, createdAt: '2026-01-01T00:00:00.000Z' });

      for (const caseId of ['a', 'b', 'c']) await store.recordCase(id, execution(id, caseId), []);
      await store.finalizeRun(id, 'completed');
    }

    const first = await store.listEvalRuns('eval', { limit: 2 });
    expect(first.items.map((row) => row.runId)).toEqual([
      '01K00000000000000000000003',
      '01K00000000000000000000002',
    ]);
    expect(
      (await store.listEvalRuns('eval', { cursor: first.nextCursor, limit: 2 })).items.map(
        (row) => row.runId,
      ),
    ).toEqual(['01K00000000000000000000001']);
    const window = await store.getEvalCaseWindow('eval', { limit: 2 });
    expect(window.items).toHaveLength(2);
    expect(window.nextCursor).toBe('b');
    expect(window.items[0]?.cells).toEqual(['pass', 'pass', 'pass']);
    const history = await store.getCaseHistory('eval', 'a', { limit: 2 });
    expect(
      (await store.getCaseHistory('eval', 'a', { limit: 2, cursor: history.nextCursor })).items[0]
        ?.runId,
    ).toBe('01K00000000000000000000001');
  });

  it('atomically backfills genuine v1 records and restores terminal immutability', async () => {
    const handle = await openSqliteHandle(await temporaryPath());

    try {
      await handle.exec(migrations[0].sql);
      await handle.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES(1,'initial','now');",
      );
      await handle
        .prepare(
          'INSERT INTO runs(id,created_at,status,schema_id,config_hash,config_json) VALUES(?,?,?,?,?,?)',
        )
        .run(
          '01K00000000000000000000001',
          '2026-01-01T00:00:00.000Z',
          'running',
          'legacy',
          'hash',
          '{}',
        );
      const e = execution('01K00000000000000000000001', 'case');
      await handle
        .prepare(
          `INSERT INTO cases(id,run_id,case_id,suite_name,outcome,started_at,duration_ms,input_hash,request_json,response_json,diagnostics_json,attempts_json,expected_metrics_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'case-row',
          '01K00000000000000000000001',
          'case',
          'eval',
          'completed',
          e.startedAt,
          10,
          'hash',
          JSON.stringify(e.request),
          JSON.stringify(e.response),
          '{}',
          '[]',
          '[]',
        );
      await handle.exec(
        "UPDATE runs SET status='completed', finished_at='2026-01-01T00:01:00.000Z', summary_json='{}'",
      );
      await expect(validateReadableSchema(handle)).rejects.toMatchObject({
        code: 'SCHEMA_OUTDATED',
      });
      await migrateToLatest(handle);
      await migrateToLatest(handle);
      expect(await handle.prepare('SELECT recorded, passed FROM run_suite_totals').all()).toEqual([
        { recorded: 1, passed: 1 },
      ]);
      expect(await handle.prepare('SELECT verdict FROM cases').all()).toEqual([
        { verdict: 'pass' },
      ]);
      await expect(handle.exec("UPDATE cases SET verdict='fail'")).rejects.toThrow('immutable');
      await expect(handle.exec('DELETE FROM run_suite_totals')).rejects.toThrow('immutable');
    } finally {
      await handle.close();
    }
  });

  it('rolls schema, backfill and trigger changes back on corrupt v1 input', async () => {
    const handle = await openSqliteHandle(await temporaryPath());

    try {
      await handle.exec(migrations[0].sql);
      await handle.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_migrations VALUES(1,'initial','now');",
      );
      await handle
        .prepare(
          'INSERT INTO runs(id,created_at,status,schema_id,config_hash,config_json) VALUES(?,?,?,?,?,?)',
        )
        .run('bad', 'not-a-date', 'running', 'legacy', 'hash', '{}');
      await expect(migrateToLatest(handle)).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
      expect(await handle.prepare('SELECT version FROM schema_migrations').all()).toEqual([
        { version: 1 },
      ]);
      expect(
        await handle
          .prepare("SELECT name FROM sqlite_master WHERE name='cases_no_finalized_update'")
          .all(),
      ).toHaveLength(1);
      expect(
        await handle.prepare("SELECT name FROM sqlite_master WHERE name='run_suite_totals'").all(),
      ).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

it('uses bounded index seeks for complete slices, history, identities, keysets and activity', async () => {
  const handle = await openSqliteHandle(await temporaryPath());

  try {
    await migrateToLatest(handle);

    const queries = [
      [
        "SELECT run_id,case_id,verdict,outcome FROM (SELECT * FROM cases INDEXED BY idx_cases_window) AS cases WHERE suite_name='eval' AND run_id IN ('a','b') AND case_id IN ('c','d')",
        'idx_cases_window',
      ],
      [
        "SELECT * FROM run_suite_totals WHERE suite_name='eval' AND state='complete' ORDER BY run_created_at DESC,run_id DESC LIMIT 1",
        'idx_totals_state',
      ],
      [
        "SELECT suite_name FROM run_suite_totals WHERE suite_name > 'eval' ORDER BY suite_name LIMIT 1",
        'idx_totals_suite',
      ],
      [
        "SELECT * FROM run_suite_totals WHERE suite_name='eval' AND (run_created_at,run_id) < ('date','id') ORDER BY run_created_at DESC,run_id DESC LIMIT 11",
        'idx_totals_suite',
      ],
      [
        "SELECT case_id FROM suite_cases WHERE suite_name='eval' AND case_id > 'case' ORDER BY case_id LIMIT 101",
        'PRIMARY KEY',
      ],
      [
        "SELECT run_id,verdict,outcome,duration_ms FROM cases WHERE suite_name='eval' AND case_id='case' ORDER BY run_created_at DESC,run_id DESC LIMIT 11",
        'idx_cases_history',
      ],
      [
        "SELECT * FROM run_suite_totals WHERE run_created_at >= 'a' AND run_created_at < 'z' ORDER BY run_created_at DESC,run_id DESC,suite_name LIMIT 10001",
        'idx_totals_created',
      ],
    ];

    for (const [query, index] of queries) {
      const plan = JSON.stringify(await handle.prepare('EXPLAIN QUERY PLAN ' + query).all());
      expect(plan).toContain(index);
      expect(plan).not.toContain('TEMP B-TREE');
      expect(plan).not.toContain('SCAN cases');
    }
  } finally {
    await handle.close();
  }
});

it('leaves v1 usable when another writer holds the migration lock, then retries atomically', async () => {
  const path = await temporaryPath();
  const owner = await openSqliteHandle(path);
  const contender = await openSqliteHandle(path);

  try {
    await owner.exec(migrations[0].sql);
    await owner.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_migrations VALUES(1,'initial','now');",
    );
    await owner.begin();
    await contender.exec('PRAGMA busy_timeout=1');
    await expect(migrateToLatest(contender)).rejects.toThrow('locked');
    await owner.rollback();
    expect(
      await contender
        .prepare("SELECT name FROM sqlite_master WHERE name='cases_no_finalized_update'")
        .all(),
    ).toHaveLength(1);
    await migrateToLatest(contender);
    await validateReadableSchema(contender);
  } finally {
    await contender.close();
    await owner.close();
  }
});

it('persists planned zero/partial slices and separates skipped from errored in a failed multi-eval run', async () => {
  const snapshot = parseWithSchemaSync(
    evalRunSchema,
    JSON.parse(
      await readFile(
        new URL(
          '../../../../contracts/src/_tests_/fixtures/eval-run/eval-run.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );

  snapshot.snapshot.selected_test_ids = ['good', 'bad', 'empty', 'partial'];
  snapshot.snapshot.selected_cases = [
    { configured_index: 0, test_id: 'good', case_id: 'one', source: { kind: 'direct' } },
    { configured_index: 1, test_id: 'bad', case_id: 'two', source: { kind: 'direct' } },
    { configured_index: 2, test_id: 'partial', case_id: 'three', source: { kind: 'direct' } },
  ];
  const store = (await openStore(await temporaryPath())).runs;
  stores.push(store);

  const run = await store.createRun({
    schemaId: snapshot.schema,
    configHash: 'hash',
    configJson: JSON.stringify(snapshot),
  });

  await store.recordCase(run.id, execution(run.id, 'one', 'good'), []);
  const completed = execution(run.id, 'two', 'bad');
  const { response, ...shared } = completed;
  expect(response).toBeDefined();
  await store.recordCase(
    run.id,
    { ...shared, outcome: 'cancelled', errorCode: 'cancelled', errorMessage: 'stopped' },
    [],
  );
  await store.finalizeRun(run.id, 'failed');
  const slices = await store.listRunSuites(run.id);
  expect(slices.find((slice) => slice.suiteName === 'good')).toMatchObject({
    state: 'complete',
    passRate: 1,
    runStatus: 'failed',
  });
  expect(slices.find((slice) => slice.suiteName === 'bad')).toMatchObject({
    state: 'incomplete',
    passRate: null,
    counts: { skipped: 1, errored: 0 },
  });
  expect(slices.find((slice) => slice.suiteName === 'empty')).toMatchObject({
    state: 'incomplete',
    counts: { planned: 0, notRun: 0 },
  });
  expect(slices.find((slice) => slice.suiteName === 'partial')).toMatchObject({
    state: 'incomplete',
    counts: { planned: 1, notRun: 1 },
  });
  const summary = (await store.listEvals()).items;
  expect(summary.find((row) => row.suiteName === 'good')?.failing).toBe(false);
  expect(summary.find((row) => row.suiteName === 'partial')?.failing).toBe(true);
});
