import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_PROTOCOL,
  TRACE_SCHEMA_VERSION,
  type AgentRequest,
  type Trace,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';

import { createSqliteDialect } from './internal/kysely-sqlite-dialect.js';
import { openSqliteHandle } from './internal/sqlite-handle.js';
import { openRunStore, type RunStore } from './run-store.js';
import type { Database } from './schema.js';
import type { StoredCaseExecution, StoredMetricEvaluation } from './types.js';

const stores: RunStore[] = [];
const directories: string[] = [];

const openTemporaryStore = async (): Promise<{ path: string; store: RunStore }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-adversarial-store-'));
  const path = join(directory, 'runs.db');
  const store = await openRunStore(path);
  directories.push(directory);
  stores.push(store);
  return { path, store };
};

const request = (runId: string, caseId: string): AgentRequest => ({
  protocol: AGENT_PROTOCOL,
  run_id: runId,
  case_id: caseId,
  input: {},
});

/** Builds the required completed execution base for adversarial persistence tests. */
const completedExecution = (
  runId: string,
  caseId: string,
): Extract<StoredCaseExecution, { outcome: 'completed' }> => ({
  caseId,
  suiteName: 'suite',
  outcome: 'completed',
  startedAt: '2026-08-06T00:00:00.000Z',
  durationMs: 1,
  request: request(runId, caseId),
  response: {},
  warnings: [],
  diagnostics: {},
  attempts: [],
  expectedMetrics: [],
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('RunStore adversarial persistence', () => {
  it('rejects every contradictory terminal execution shape before persistence', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    const valid = completedExecution(run.id, 'invalid');
    const matrix: Array<[unknown, string]> = [
      [{ ...valid, errorCode: 'network' }, 'forbids errorCode'],
      [
        {
          ...valid,
          outcome: 'timeout',
          errorCode: 'timeout',
          errorMessage: 'late',
          response: {},
        },
        'forbids response',
      ],
      [
        {
          ...valid,
          outcome: 'timeout',
          errorCode: 'timeout',
          errorMessage: 'late',
          trace: { schema: TRACE_SCHEMA_VERSION, trace_id: 'invalid', spans: [] },
        },
        'forbids trace',
      ],
    ];

    for (const [invalid, violation] of matrix) {
      const failure = await store
        .recordCase(run.id, invalid as StoredCaseExecution, [])
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'INVALID_RECORD' });
      expect(failure).toHaveProperty('message', expect.stringContaining(violation));
    }
    await expect(store.getCaseResults(run.id)).resolves.toEqual([]);
  });

  it('ignores non-scalar span attributes and stringifies numbers and booleans', async () => {
    const { path, store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    const baseSpan = {
      span_id: 'base',
      parent_span_id: null,
      kind: 'tool',
      name: 'search',
      start_time: '2026-08-06T00:00:00.000Z',
      end_time: '2026-08-06T00:00:01.000Z',
    };
    const defensiveTrace = {
      schema: TRACE_SCHEMA_VERSION,
      trace_id: 'defensive',
      spans: [
        {
          ...baseSpan,
          span_id: 'wrong-object',
          attributes: { 'gen_ai.tool.name': {}, 'gen_ai.request.model': [] },
        },
        {
          ...baseSpan,
          span_id: 'wrong-null',
          attributes: { 'gen_ai.tool.name': null, 'gen_ai.request.model': null },
        },
        {
          ...baseSpan,
          span_id: 'valid-scalars',
          attributes: { 'gen_ai.tool.name': 42, 'gen_ai.request.model': false },
        },
      ],
    } as unknown as Trace;
    await store.recordCase(
      run.id,
      { ...completedExecution(run.id, 'defensive-trace'), trace: defensiveTrace },
      [],
    );

    const handle = await openSqliteHandle(path);
    const rows = await handle
      .prepare('SELECT span_id, tool_name, model_name FROM spans ORDER BY span_id')
      .all();
    await handle.close();
    expect(rows).toEqual([
      { span_id: 'valid-scalars', tool_name: '42', model_name: 'false' },
      { span_id: 'wrong-null', tool_name: null, model_name: null },
      { span_id: 'wrong-object', tool_name: null, model_name: null },
    ]);
  });

  it('serializes five concurrent case transactions without losing writes', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) => {
        const caseId = `concurrent-${index}`;
        return store.recordCase(
          run.id,
          { ...completedExecution(run.id, caseId), durationMs: index },
          [{ metricName: 'quality', kind: 'assertion', status: 'evaluated', score: 1, pass: true }],
        );
      }),
    );

    expect((await store.getCaseResults(run.id)).map((record) => record.caseId).sort()).toEqual([
      'concurrent-0',
      'concurrent-1',
      'concurrent-2',
      'concurrent-3',
      'concurrent-4',
    ]);
  });

  it('rolls back the whole case and wraps a duplicate child-row failure', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    const execution = completedExecution(run.id, 'rolled-back');
    const duplicateMetrics: StoredMetricEvaluation[] = [
      { metricName: 'duplicate', kind: 'assertion', status: 'evaluated', score: 1, pass: true },
      { metricName: 'duplicate', kind: 'assertion', status: 'evaluated', score: 0, pass: false },
    ];

    const failure = await store
      .recordCase(run.id, execution, duplicateMetrics)
      .catch((error) => error);
    expect(failure).toMatchObject({ code: 'WRITE_FAILED', cause: expect.anything() });
    await expect(store.getCaseResults(run.id)).resolves.toEqual([]);
  });

  it('reports malformed persisted JSON as CORRUPT_DATA with its parse cause', async () => {
    const { path, store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    await store.recordCase(run.id, completedExecution(run.id, 'corrupt'), []);
    const handle = await openSqliteHandle(path);
    await handle.prepare('UPDATE cases SET request_json = ? WHERE run_id = ?').run('{', run.id);
    await handle.close();

    const failure = await store.getCaseResults(run.id).catch((error) => error);
    expect(failure).toMatchObject({ code: 'CORRUPT_DATA', cause: expect.any(SyntaxError) });
  });

  it('wraps schema CHECK violations as WRITE_FAILED with the driver cause', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });

    const failure = await store
      .recordCase(run.id, { ...completedExecution(run.id, 'negative'), durationMs: -1 }, [])
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'WRITE_FAILED', cause: expect.anything() });
  });

  it('wraps metric CHECK violations as WRITE_FAILED and rolls back the case', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });

    const failure = await store
      .recordCase(run.id, completedExecution(run.id, 'invalid-metric'), [
        { metricName: 'quality', kind: 'assertion', status: 'evaluated' },
      ])
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'WRITE_FAILED', cause: expect.anything() });
    await expect(store.getCaseResults(run.id)).resolves.toEqual([]);
  });

  it('blocks raw Kysely mutations after a run is finalized', async () => {
    const { path, store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    await store.recordCase(run.id, completedExecution(run.id, 'immutable'), [
      { metricName: 'quality', kind: 'assertion', status: 'evaluated', score: 1, pass: true },
    ]);
    await store.finalizeRun(run.id, 'completed');

    const handle = await openSqliteHandle(path);
    const database = new Kysely<Database>({ dialect: createSqliteDialect(handle) });
    await expect(
      database.updateTable('runs').set({ summary_json: '{}' }).where('id', '=', run.id).execute(),
    ).rejects.toThrow('attest: finalized runs are immutable');
    await expect(
      database
        .insertInto('cases')
        .values({
          id: 'raw-finalized-case',
          run_id: run.id,
          case_id: 'raw-finalized-case',
          suite_name: 'suite',
          outcome: 'completed',
          started_at: '2026-08-06T00:00:00.000Z',
          duration_ms: 1,
          input_hash: 'hash',
          request_json: '{}',
          response_json: '{}',
          error_code: null,
          error_message: null,
          warnings_json: '[]',
          diagnostics_json: '{}',
          attempts_json: '[]',
          expected_metrics_json: '[]',
          trace_json: null,
        })
        .execute(),
    ).rejects.toThrow('attest: finalized runs are immutable');
    const [metric] = await database.selectFrom('metric_results').select(['id']).execute();
    expect(metric).toBeDefined();
    await expect(
      database.deleteFrom('metric_results').where('id', '=', metric!.id).execute(),
    ).rejects.toThrow('attest: finalized runs are immutable');
    await database.destroy();
  });
});
