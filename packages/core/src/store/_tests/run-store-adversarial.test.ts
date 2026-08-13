import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_PROTOCOL, TRACE_SCHEMA_ID, type AgentRequest } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';

import { createSqliteDialect } from '../internal/kysely-sqlite-dialect.js';
import { openSqliteHandle } from '../internal/sqlite-handle.js';
import { openStore, type RunStore } from '../run-store.js';
import type { Database } from '../schema.js';
import { StoreError, type StoredCaseExecution, type StoredMetricEvaluation } from '../types.js';

const stores: RunStore[] = [];
const directories: string[] = [];

const openTemporaryStore = async (): Promise<{ path: string; store: RunStore }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-adversarial-store-'));
  const path = join(directory, 'runs.db');
  const store = (await openStore(path)).runs;
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

/** Captures a rejected operation while keeping the failure type unknown until asserted. */
const captureRejection = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
};

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
      schemaId: 'attest.project',
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
          trace: { schema: TRACE_SCHEMA_ID, trace_id: 'invalid', spans: [] },
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

  it('treats explicitly undefined forbidden fields like omitted JSON properties', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const completed = {
      ...completedExecution(run.id, 'completed-with-undefined'),
      errorCode: undefined,
      errorMessage: undefined,
      attempts: [
        {
          status: 'ok',
          durationMs: 1,
          diagnostics: {},
          warnings: [],
          errorCode: undefined,
          errorMessage: undefined,
        },
      ],
    };
    const evaluated = {
      metricName: 'quality',
      kind: 'assertion',
      status: 'evaluated',
      score: 1,
      pass: true,
      error: undefined,
    };
    const failed = {
      ...completedExecution(run.id, 'failed-with-undefined'),
      outcome: 'timeout',
      errorCode: 'timeout',
      errorMessage: 'late',
      response: undefined,
      trace: undefined,
    };
    const errored = {
      metricName: 'quality',
      kind: 'assertion',
      status: 'error',
      error: { message: 'late', kind: 'timeout' },
      score: undefined,
      pass: undefined,
    };

    await store.recordCase(
      run.id,
      completed as unknown as StoredCaseExecution,
      [evaluated] as unknown as StoredMetricEvaluation[],
    );
    await store.recordCase(
      run.id,
      failed as unknown as StoredCaseExecution,
      [errored] as unknown as StoredMetricEvaluation[],
    );
    await expect(store.getCaseResults(run.id)).resolves.toHaveLength(2);
  });

  it('aggregates all execution and evaluation violations before persistence', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const invalid = {
      ...completedExecution(run.id, 'invalid'),
      caseId: '',
      suiteName: '',
      startedAt: 'yesterday',
      durationMs: Number.NaN,
      request: {},
      warnings: [{ path: 1, message: false, code: 'other' }],
      diagnostics: { exitCode: 1.5, httpStatus: 'bad', stderrExcerpt: 4 },
      attempts: [
        { status: 'ok', durationMs: -1, diagnostics: null, errorCode: 'timeout' },
        { status: 'other', durationMs: Number.POSITIVE_INFINITY, diagnostics: {} },
      ],
      expectedMetrics: ['valid', 4],
      trace: { schema: TRACE_SCHEMA_ID, trace_id: 'bad', spans: [{}] },
    };
    const evaluations = [
      { metricName: '', kind: 'other', status: 'evaluated', score: Number.NaN, pass: 'yes' },
      { metricName: 'error', kind: 'judge', status: 'error', error: { message: '', kind: 1 } },
    ];
    const failure = await captureRejection(
      store.recordCase(
        run.id,
        invalid as unknown as StoredCaseExecution,
        evaluations as unknown as StoredMetricEvaluation[],
      ),
    );
    expect(failure).toMatchObject({ code: 'INVALID_RECORD' });
    expect(failure).toHaveProperty('message', expect.stringContaining('caseId'));
    expect(failure).toHaveProperty('message', expect.stringContaining('suiteName'));
    expect(failure).toHaveProperty('message', expect.stringContaining('startedAt'));
    expect(failure).toHaveProperty('message', expect.stringContaining('durationMs'));
    expect(failure).toHaveProperty('message', expect.stringContaining('diagnostics.exitCode'));
    expect(failure).toHaveProperty('message', expect.stringContaining('attempts[0]'));
    expect(failure).toHaveProperty('message', expect.stringContaining('expectedMetrics[1]'));
    expect(failure).toHaveProperty('message', expect.stringContaining('trace'));
    expect(failure).toHaveProperty('message', expect.stringContaining('evaluations[0]'));
    expect(failure).toHaveProperty('message', expect.stringContaining('evaluations[1]'));
    await expect(store.getCaseResults(run.id)).resolves.toEqual([]);
  });

  it('serializes five concurrent case transactions without losing writes', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
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
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const execution = completedExecution(run.id, 'rolled-back');
    const duplicateMetrics: StoredMetricEvaluation[] = [
      { metricName: 'duplicate', kind: 'assertion', status: 'evaluated', score: 1, pass: true },
      { metricName: 'duplicate', kind: 'assertion', status: 'evaluated', score: 0, pass: false },
    ];

    const failure = await captureRejection(store.recordCase(run.id, execution, duplicateMetrics));
    expect(failure).toMatchObject({ code: 'WRITE_FAILED' });
    expect(failure).toBeInstanceOf(StoreError);
    if (failure instanceof StoreError) expect(failure.cause).toBeDefined();
    await expect(store.getCaseResults(run.id)).resolves.toEqual([]);
  });

  it('reports malformed persisted JSON as CORRUPT_DATA with its parse cause', async () => {
    const { path, store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    await store.recordCase(run.id, completedExecution(run.id, 'corrupt'), []);
    const handle = await openSqliteHandle(path);
    await handle.prepare('UPDATE cases SET request_json = ? WHERE run_id = ?').run('{', run.id);
    await handle.close();

    const failure = await captureRejection(store.getCaseResults(run.id));
    expect(failure).toMatchObject({ code: 'CORRUPT_DATA' });
    expect(failure).toBeInstanceOf(StoreError);
    if (failure instanceof StoreError) expect(failure.cause).toBeInstanceOf(SyntaxError);
  });

  it('rejects invalid scalar fields before reaching schema checks', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });

    const failure = await captureRejection(
      store.recordCase(run.id, { ...completedExecution(run.id, 'negative'), durationMs: -1 }, []),
    );

    expect(failure).toMatchObject({ code: 'INVALID_RECORD' });
  });

  it('rejects invalid metric branches before opening the case transaction', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });

    const failure = await captureRejection(
      store.recordCase(run.id, completedExecution(run.id, 'invalid-metric'), [
        { metricName: 'quality', kind: 'assertion', status: 'evaluated' },
      ] as unknown as StoredMetricEvaluation[]),
    );

    expect(failure).toMatchObject({ code: 'INVALID_RECORD' });
    await expect(store.getCaseResults(run.id)).resolves.toEqual([]);
  });

  it('blocks raw Kysely mutations after a run is finalized', async () => {
    const { path, store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
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
    await expect(database.deleteFrom('runs').where('id', '=', run.id).execute()).rejects.toThrow(
      'attest: finalized runs are immutable',
    );
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
