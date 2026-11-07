import { readFileSync } from 'node:fs';
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

const fixture = parseWithSchemaSync(
  evalRunSchema,
  JSON.parse(
    readFileSync(
      new URL('../../../../contracts/src/_tests_/fixtures/eval-run/eval-run.json', import.meta.url),
      'utf8',
    ),
  ),
);

const metadata = {
  schemaId: fixture.schema,
  configHash: 'hash',
  configJson: JSON.stringify(fixture),
};

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
    const run = await a.createRun(selectedMetadata({ eval: ['a', 'b', 'c', 'rollback'] }));
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
      await store.createRun(selectedMetadata({ eval: ['a', 'b', 'c'] }), {
        id,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

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
    expect(window.nextCursor).toBeDefined();
    expect(window.items[0]?.cells).toEqual(['pass', 'pass', 'pass']);
    const history = await store.getCaseHistory('eval', 'a', { limit: 2 });
    expect(
      (await store.getCaseHistory('eval', 'a', { limit: 2, cursor: history.nextCursor })).items[0]
        ?.runId,
    ).toBe('01K00000000000000000000001');
  });

  it.each(['legacy', 'current', 'duplicates', 'absent', 'overplan', 'foreign', 'wrongcase'])(
    'atomically backfills %s v1 records and restores terminal immutability',
    async (historicalKind) => {
      const path = await temporaryPath();
      const handle = await openSqliteHandle(path);

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
            '2026-01-01T00:00:00Z',
            'running',
            historicalKind === 'legacy' ? 'legacy' : fixture.schema,
            'hash',
            historicalKind === 'overplan'
              ? JSON.stringify({ snapshot: { selected_test_ids: ['eval'], selected_cases: [] } })
              : historicalKind === 'legacy'
                ? '{}'
                : historicalKind === 'absent'
                  ? JSON.stringify({
                      snapshot: {},
                      effective_command: { request: { tags: ['old', 'old'] } },
                    })
                  : historicalKind === 'duplicates'
                    ? JSON.stringify({
                        ...fixture,
                        snapshot: {
                          ...fixture.snapshot,
                          selected_test_ids: ['eval', 'eval'],
                          selected_cases: [
                            {
                              configured_index: 0,
                              test_id: 'eval',
                              case_id: 'case',
                              source: { kind: 'direct' },
                            },
                          ],
                        },
                        effective_command: {
                          ...fixture.effective_command,
                          request: {
                            ...fixture.effective_command.request,
                            tags: ['old', 'old'],
                            test_ids: ['eval', 'eval'],
                          },
                        },
                      })
                    : selectedMetadata(
                        historicalKind === 'foreign'
                          ? { other: ['case'] }
                          : historicalKind === 'wrongcase'
                            ? { eval: ['selected'] }
                            : { eval: ['case'] },
                      ).configJson,
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

        if (['overplan', 'foreign', 'wrongcase'].includes(historicalKind)) {
          await expect(migrateToLatest(handle)).rejects.toThrow(
            'Unselected evidence in run 01K00000000000000000000001, suite eval, case case.',
          );
          expect(await handle.prepare('SELECT version FROM schema_migrations').all()).toEqual([
            { version: 1 },
          ]);

          expect(
            await handle
              .prepare(
                "SELECT name FROM sqlite_master WHERE name IN ('run_suite_totals','run_selected_cases','eval_suites')",
              )
              .all(),
          ).toEqual([]);
          expect(await handle.prepare('SELECT case_id,suite_name FROM cases').all()).toEqual([
            { case_id: 'case', suite_name: 'eval' },
          ]);

          return;
        }

        const before = await readFile(path);
        await expect(openReadonlyRunStore(path)).rejects.toMatchObject({ code: 'SCHEMA_OUTDATED' });
        expect(await readFile(path)).toEqual(before);
        await migrateToLatest(handle);
        await migrateToLatest(handle);
        const reader = await openReadonlyRunStore(path);
        stores.push(reader);
        const catalog = (await reader.listEvals()).items;

        if (historicalKind === 'legacy') expect(catalog).toHaveLength(0);
        else expect(catalog[0]?.failing).toBe(historicalKind === 'absent' ? null : false);
        expect(await handle.prepare('SELECT created_at,created_order FROM runs').all()).toEqual([
          { created_at: '2026-01-01T00:00:00Z', created_order: '2026-01-01T00:00:00.000Z' },
        ]);
        expect(await handle.prepare('SELECT recorded, passed FROM run_suite_totals').all()).toEqual(
          [{ recorded: 1, passed: 1 }],
        );

        if (historicalKind !== 'legacy')
          expect(await handle.prepare('SELECT planned,state FROM run_suite_totals').all()).toEqual([
            {
              planned: historicalKind === 'absent' ? null : 1,
              state: historicalKind === 'absent' ? 'incomplete' : 'complete',
            },
          ]);
        expect(await handle.prepare('SELECT verdict FROM cases').all()).toEqual([
          { verdict: 'pass' },
        ]);
        await expect(handle.exec("UPDATE cases SET verdict='fail'")).rejects.toThrow('immutable');
        await expect(handle.exec('DELETE FROM run_suite_totals')).rejects.toThrow('immutable');
      } finally {
        await handle.close();
      }
    },
  );

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
  expect(slices.find((slice) => slice.suiteName === 'empty')).toBeUndefined();
  expect(slices.find((slice) => slice.suiteName === 'partial')).toMatchObject({
    state: 'incomplete',
    counts: { planned: 1, notRun: 1 },
  });
  const summary = (await store.listEvals()).items;
  expect(summary.find((row) => row.suiteName === 'good')?.failing).toBe(false);
  expect(summary.find((row) => row.suiteName === 'partial')?.failing).toBe(true);
});

it('excludes probes and canonicalizes timestamp bounds', async () => {
  const store = (await openStore(await temporaryPath())).runs;
  stores.push(store);

  const run = await store.createRun(
    { schemaId: 'attest.agent-test', configHash: 'hash', configJson: '{}' },
    { id: '01K00000000000000000000009', createdAt: '2026-01-01T00:00:00Z' },
  );

  await store.recordCase(run.id, execution(run.id, 'probe', 'agent:probe'), []);
  await store.finalizeRun(run.id, 'completed');
  expect(await store.listRunSuites(run.id)).toHaveLength(1);
  expect((await store.listEvals()).items).toHaveLength(0);
  expect(
    (await store.getActivity({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00.500Z' }))
      .days,
  ).toHaveLength(0);
});

/** Builds a current live snapshot with only the requested participation. */
const selectedMetadata = (suites: Record<string, string[]>) => {
  const config = structuredClone(fixture);
  config.snapshot.selected_test_ids = Object.keys(suites);
  config.snapshot.selected_cases = Object.entries(suites).flatMap(([test_id, cases]) =>
    cases.map((case_id) => ({
      test_id,
      case_id,
      configured_index: 0,
      source: { kind: 'direct' as const },
    })),
  );
  config.snapshot.selected_cases.forEach((row, i) => {
    row.configured_index = i;
  });

  return { ...metadata, configJson: JSON.stringify(config) };
};

it('omits zero participation without changing another eval history, and rolls over-plan writes back', async () => {
  const store = (await openStore(await temporaryPath())).runs;
  stores.push(store);

  const first = await store.createRun(selectedMetadata({ a: ['one'], b: ['two'] }), {
    id: '01K00000000000000000000001',
    createdAt: '2026-01-01T00:00:00Z',
  });

  await store.recordCase(first.id, execution(first.id, 'one', 'a'), []);
  await store.recordCase(first.id, execution(first.id, 'two', 'b'), []);
  await store.finalizeRun(first.id, 'completed');
  const before = await store.getEvalCaseWindow('b');

  const second = await store.createRun(selectedMetadata({ a: ['one'], b: [] }), {
    id: '01K00000000000000000000002',
    createdAt: '2026-01-02T00:00:00+00:00',
  });

  await store.recordCase(second.id, execution(second.id, 'one', 'a'), []);
  await expect(
    store.recordCase(second.id, execution(second.id, 'extra', 'a'), []),
  ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
  expect((await store.listCaseSummaries(second.id)).items).toHaveLength(1);
  expect((await store.listRunSuites(second.id))[0]?.counts.recorded).toBe(1);
  expect((await store.getEvalCaseWindow('a')).items.map((row) => row.caseId)).not.toContain(
    'extra',
  );
  await store.finalizeRun(second.id, 'completed');
  expect(await store.getEvalCaseWindow('b')).toEqual(before);
  expect((await store.listEvalRuns('b')).items).toHaveLength(1);
  expect((await store.getCaseHistory('b', 'two')).items).toHaveLength(1);
  expect(
    (
      await store.listEvalRuns('a', {
        since: '2025-12-31T19:00:00-05:00',
        until: '2026-01-01T00:00:00.500Z',
      })
    ).items,
  ).toHaveLength(1);
  await expect(store.listEvalRuns('a', { until: '2026-02-30T00:00:00Z' })).rejects.toMatchObject({
    code: 'INVALID_LIMIT',
  });
  await expect(
    store.createRun(metadata, { id: 'bad', createdAt: 'invalid' }),
  ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
});

it('keeps ten-run columns stable across three pages and rejects foreign-suite cursors', async () => {
  const path = await temporaryPath();
  const store = (await openStore(path)).runs;
  stores.push(store);
  const ids = Array.from({ length: 2500 }, (_, i) => 'c' + String(i).padStart(4, '0'));
  const first = await store.createRun(selectedMetadata({ wide: ids, other: ['a', 'b'] }));

  for (const id of ids)
    await store.recordCase(
      first.id,
      execution(first.id, id, 'wide'),
      id === 'c0000'
        ? [{ metricName: 'm', kind: 'assertion', status: 'evaluated', score: 1, pass: true }]
        : [],
    );

  for (const id of ['a', 'b'])
    await store.recordCase(first.id, execution(first.id, id, 'other'), []);
  const other = await store.listCaseSummaries(first.id, { suiteName: 'other', limit: 1 });
  expect(other.items.every((row) => row.suiteName === 'other')).toBe(true);
  await expect(
    store.listCaseSummaries(first.id, { suiteName: 'wide', cursor: other.nextCursor }),
  ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  const page1 = await store.getEvalCaseWindow('wide', { limit: 1000 });
  const filling = await store.createRun(selectedMetadata({ wide: ['c1000'] }));
  const snapshot = await store.getEvalCaseWindow('wide', { limit: 1000 });
  await store.recordCase(filling.id, execution(filling.id, 'c1000', 'wide'), []);

  const filled = await store.getEvalCaseWindow('wide', {
    limit: 1000,
    cursor: snapshot.nextCursor,
  });

  expect(filled.runs.map((row) => row.runId)).toEqual(snapshot.runs.map((row) => row.runId));
  expect(filled.items.find((row) => row.caseId === 'c1000')?.cells[0]).toBe('pass');
  const newRun = await store.createRun(selectedMetadata({ wide: ['c0000'] }));
  await store.recordCase(newRun.id, execution(newRun.id, 'c0000', 'wide'), []);
  const page2 = await store.getEvalCaseWindow('wide', { limit: 1000, cursor: page1.nextCursor });
  const page3 = await store.getEvalCaseWindow('wide', { limit: 1000, cursor: page2.nextCursor });
  expect([...page1.items, ...page2.items, ...page3.items].map((row) => row.caseId)).toEqual(ids);
  expect(page2.runs.map((run) => run.runId)).toEqual(page1.runs.map((run) => run.runId));
  expect(page3.runs.map((run) => run.runId)).toEqual(page1.runs.map((run) => run.runId));
  expect(page3.nextCursor).toBeUndefined();
  await expect(
    store.getEvalCaseWindow('foreign', { cursor: page1.nextCursor }),
  ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  const handle = await openSqliteHandle(path);

  try {
    await expect(handle.exec("UPDATE cases SET verdict='fail'")).rejects.toThrow('immutable');
    await expect(handle.exec('DELETE FROM cases')).rejects.toThrow('immutable');
    await expect(handle.exec('UPDATE metric_results SET score=0')).rejects.toThrow('immutable');
    await expect(handle.exec('DELETE FROM metric_results')).rejects.toThrow('immutable');
  } finally {
    await handle.close();
  }
});

it('reports an empty covered interval when the activity cap splits a single UTC day including ties', async () => {
  const store = (await openStore(await temporaryPath())).runs;
  stores.push(store);
  const suites = Object.fromEntries(Array.from({ length: 10002 }, (_, i) => ['e' + i, ['c']]));
  await store.createRun(selectedMetadata(suites), {
    id: '01K00000000000000000000001',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const activity = await store.getActivity({
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
  });

  expect(activity).toMatchObject({
    days: [],
    truncated: true,
    coveredFrom: '2026-01-02T00:00:00.000Z',
    coveredTo: '2026-01-02T00:00:00.000Z',
  });
  await store.createRun(selectedMetadata({ recent: ['c'] }), {
    id: '01K00000000000000000000002',
    createdAt: '2026-01-02T00:00:00Z',
  });
  expect(
    await store.getActivity({ from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' }),
  ).toMatchObject({
    coveredFrom: '2026-01-02T00:00:00.000Z',
    coveredTo: '2026-01-03T00:00:00.000Z',
    truncated: true,
    days: [{ day: '2026-01-02', slices: 1 }],
  });
});

it('rejects unselected live identities atomically, preserves exact evidence time and permits terminal replay', async () => {
  const path = await temporaryPath();
  const store = (await openStore(path)).runs;
  stores.push(store);
  const createdAt = '2026-01-01T05:30:00.123456+05:30';

  const run = await store.createRun(selectedMetadata({ a: ['selected'], empty: [] }), {
    id: '01K00000000000000000000008',
    createdAt,
  });

  const handle = await openSqliteHandle(path);

  try {
    for (const [suite, caseId] of [
      ['foreign', 'selected'],
      ['a', 'wrong-case'],
      ['empty', 'selected'],
    ]) {
      await expect(
        store.recordCase(run.id, execution(run.id, caseId!, suite), []),
      ).rejects.toMatchObject({
        code: 'INVALID_RECORD',
      });
      expect((await store.listCaseSummaries(run.id)).items).toHaveLength(0);
      expect(await handle.prepare('SELECT recorded FROM run_suite_totals').all()).toEqual([
        { recorded: 0 },
      ]);
      expect(await handle.prepare('SELECT * FROM suite_cases').all()).toEqual([]);
      expect(await handle.prepare('SELECT suite_name FROM eval_suites').all()).toEqual([
        { suite_name: 'a' },
      ]);
    }

    expect(run.createdAt).toBe(createdAt);
    expect((await store.getRun(run.id)).createdAt).toBe(createdAt);
    expect(await handle.prepare('SELECT created_at,created_order FROM runs').all()).toEqual([
      { created_at: createdAt, created_order: '2026-01-01T00:00:00.123Z' },
    ]);
    await expect(
      handle.prepare('INSERT INTO run_selected_cases VALUES(?,?,?)').run(run.id, 'a', 'extra'),
    ).rejects.toThrow('immutable');
    const selected = execution(run.id, 'selected', 'a');
    await store.recordCase(run.id, selected, []);
    await store.finalizeRun(run.id, 'completed');
    await store.recordCase(run.id, selected, []);
    await expect(handle.exec("UPDATE run_selected_cases SET case_id='changed'")).rejects.toThrow(
      'immutable',
    );
    await expect(handle.exec('DELETE FROM run_selected_cases')).rejects.toThrow('immutable');
    await expect(handle.exec('UPDATE runs SET selection_known=0')).rejects.toThrow('immutable');
    expect(
      (
        await store.listEvalRuns('a', {
          since: '2026-01-01T00:00:00.123Z',
          until: '2026-01-01T00:00:00.124Z',
        })
      ).items[0],
    ).toMatchObject({ createdAt: '2026-01-01T00:00:00.123Z', state: 'complete' });
    expect((await store.listEvalRuns('a', { until: '2026-01-01T00:00:00.123Z' })).items).toEqual(
      [],
    );
  } finally {
    await handle.close();
  }
});

it('classifies invalid live configs before writing any rows', async () => {
  const path = await temporaryPath();
  const store = (await openStore(path)).runs;
  stores.push(store);

  const contradictory = parseWithSchemaSync(
    evalRunSchema,
    JSON.parse(selectedMetadata({ a: ['selected'] }).configJson),
  );

  contradictory.snapshot.selected_test_ids = ['foreign'];

  for (const configJson of ['{}', '{', JSON.stringify(contradictory)]) {
    await expect(store.createRun({ ...metadata, configJson })).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    });
  }

  expect((await store.listRuns()).items).toEqual([]);
  expect((await store.listEvals()).items).toEqual([]);
});

it('keeps store corruption distinct from invalid case-window tokens', async () => {
  const path = await temporaryPath();
  const store = (await openStore(path)).runs;
  stores.push(store);
  const run = await store.createRun(selectedMetadata({ a: ['one', 'two'] }));
  await store.recordCase(run.id, execution(run.id, 'one', 'a'), []);
  await store.recordCase(run.id, execution(run.id, 'two', 'a'), []);
  const first = await store.getEvalCaseWindow('a', { limit: 1 });
  const handle = await openSqliteHandle(path);

  try {
    await handle.exec('UPDATE run_suite_totals SET passed=0, failed=2, scoreSum=1e999');
    await expect(store.getEvalCaseWindow('a', { cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
    await expect(store.getEvalCaseWindow('a', { cursor: '%invalid' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    await handle.exec(
      'UPDATE run_suite_totals SET scoreSum=0; PRAGMA foreign_keys=OFF; DELETE FROM runs',
    );
    await expect(store.getEvalCaseWindow('a', { cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
  } finally {
    await handle.close();
  }
});
