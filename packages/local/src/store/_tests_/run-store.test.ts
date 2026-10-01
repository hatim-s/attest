import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_PROTOCOL, TRACE_SCHEMA_ID, type AgentRequest, type Trace } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { StoreError, type StoredCaseExecution, type StoredMetricEvaluation } from '@attest/core';
import { Kysely } from 'kysely';

import { createSqliteDialect } from '../internal/kysely-sqlite-dialect.js';
import { openSqliteHandle } from '../internal/open-sqlite-handle.js';
import { openStore, type RunStore } from '../run-store.js';
import type { Database } from '../schema.js';

const stores: RunStore[] = [];
const directories: string[] = [];

const openTemporaryStore = async (): Promise<{ path: string; store: RunStore }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-run-store-'));
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
  input: { zeta: 2, alpha: 'input' },
});

interface ExecutionOptions {
  runId: string;
  caseId: string;
  expectedMetrics?: string[];
  response?: unknown;
  trace?: Trace;
}

/** Builds a runner-aligned completed execution with explicit empty diagnostic collections. */
const completedExecution = (
  options: ExecutionOptions,
): Extract<StoredCaseExecution, { outcome: 'completed' }> => ({
  caseId: options.caseId,
  suiteName: 'suite',
  outcome: 'completed',
  startedAt: '2026-08-06T00:00:00.000Z',
  durationMs: 10,
  request: request(options.runId, options.caseId),
  response: options.response ?? { output: 'ok' },
  warnings: [],
  diagnostics: {},
  attempts: [],
  expectedMetrics: options.expectedMetrics ?? [],
  trace: options.trace,
});

const evaluatedMetric = (metricName: string, pass: boolean): StoredMetricEvaluation => ({
  metricName,
  kind: 'assertion',
  status: 'evaluated',
  score: pass ? 1 : 0,
  pass,
});

const trace: Trace = {
  schema: TRACE_SCHEMA_ID,
  trace_id: 'trace-1',
  spans: [
    {
      span_id: 'span-1',
      parent_span_id: null,
      kind: 'tool',
      name: 'search',
      start_time: '2026-08-06T01:02:03.000Z',
      end_time: '2026-08-06T01:02:04.000Z',
      status: { code: 'ok' },
    },
  ],
};

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

describe('RunStore', () => {
  it('round-trips runner diagnostics, attempts, warnings, expected metrics, response, and trace', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
      labels: { environment: 'test' },
    });
    const execution: StoredCaseExecution = {
      ...completedExecution({
        runId: run.id,
        caseId: 'round-trip',
        expectedMetrics: ['quality'],
        trace,
      }),
      warnings: [{ path: 'output.extra', message: 'preserved', code: 'unknown_field' }],
      diagnostics: { stderrExcerpt: 'diagnostic', exitCode: 0, unreapedProcessIds: [1234] },
      attempts: [
        {
          status: 'invocation_error',
          errorCode: 'network',
          errorMessage: 'retry',
          durationMs: 4,
          diagnostics: { httpStatus: 503, unreapedProcessIds: [5678] },
          warnings: [],
        },
        { status: 'ok', durationMs: 6, diagnostics: {}, warnings: [] },
      ],
    };
    const metric = evaluatedMetric('quality', true);

    await store.recordCase(run.id, execution, [metric]);
    const finalized = await store.finalizeRun(run.id, 'completed');
    const stored = await store.getCase(run.id, 'suite', 'round-trip');

    expect(stored).toMatchObject({ ...execution, runId: run.id, metrics: [metric] });
    expect(finalized.summary).toEqual({
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      errorCases: 0,
      metricErrorCount: 0,
    });
  });

  it('requires the execution discriminant and required collection fields before writing', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const valid = completedExecution({ runId: run.id, caseId: 'invalid' });
    const matrix: unknown[] = [
      { ...valid, errorCode: 'network' },
      { ...valid, outcome: 'timeout', errorCode: 'timeout', errorMessage: 'late', response: {} },
      {
        ...valid,
        outcome: 'timeout',
        errorCode: 'timeout',
        errorMessage: 'late',
        trace: { schema: TRACE_SCHEMA_ID, trace_id: 'invalid', spans: [] },
      },
      { ...valid, attempts: undefined },
      { ...valid, diagnostics: { unreapedProcessIds: [0, 1.5] } },
    ];
    for (const invalid of matrix) {
      await expect(
        store.recordCase(run.id, invalid as StoredCaseExecution, []),
      ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    }
    await expect(store.getCaseResults(run.id)).resolves.toEqual([]);
    await expect(store.recordCase(run.id, valid, [])).resolves.toBeUndefined();
  });

  it('classifies missing expected rows as error and ignores extra rows for verdict semantics', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    await store.recordCase(
      run.id,
      completedExecution({ runId: run.id, caseId: 'pass', expectedMetrics: ['expected'] }),
      [evaluatedMetric('expected', true), evaluatedMetric('extra', false)],
    );
    await store.recordCase(
      run.id,
      completedExecution({ runId: run.id, caseId: 'missing', expectedMetrics: ['absent'] }),
      [],
    );
    await store.recordCase(
      run.id,
      {
        caseId: 'timeout',
        suiteName: 'suite',
        outcome: 'timeout',
        errorCode: 'timeout',
        errorMessage: 'late',
        startedAt: '2026-08-06T00:00:00.000Z',
        durationMs: 10,
        request: request(run.id, 'timeout'),
        warnings: [],
        diagnostics: {},
        attempts: [],
        expectedMetrics: [],
      },
      [],
    );

    const finalized = await store.finalizeRun(run.id, 'failed');
    expect(finalized.summary).toMatchObject({ passedCases: 1, failedCases: 0, errorCases: 2 });
  });

  it('accepts identical case replay and rejects a changed natural-key payload', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const execution = completedExecution({ runId: run.id, caseId: 'retry' });
    await store.recordCase(run.id, execution, []);
    await expect(store.recordCase(run.id, execution, [])).resolves.toBeUndefined();
    await expect(
      store.recordCase(run.id, { ...execution, durationMs: 11 }, []),
    ).rejects.toMatchObject({ code: 'CASE_CONFLICT' });
    expect(await store.getCaseResults(run.id)).toHaveLength(1);
  });

  it('returns the existing finalization for same-status retry and rejects a different status', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const first = await store.finalizeRun(run.id, 'completed');
    await expect(store.finalizeRun(run.id, 'completed')).resolves.toEqual(first);
    await expect(store.finalizeRun(run.id, 'failed')).rejects.toMatchObject({
      code: 'RUN_FINALIZED',
    });
  });

  it('paginates stable blob-free summaries and resolves single-case absence distinctly', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    for (const caseId of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
      await store.recordCase(
        run.id,
        completedExecution({
          runId: run.id,
          caseId,
          expectedMetrics: caseId === 'three' ? ['missing'] : ['quality'],
          response: { output: caseId },
          trace,
        }),
        caseId === 'three' ? [] : [evaluatedMetric('quality', caseId !== 'two')],
      );
    }
    const first = await store.listCaseSummaries(run.id, { limit: 3 });
    const firstRetry = await store.listCaseSummaries(run.id, { limit: 3 });
    const second = await store.listCaseSummaries(run.id, { limit: 3, cursor: first.nextCursor });
    const third = await store.listCaseSummaries(run.id, { limit: 3, cursor: second.nextCursor });
    expect(first).toEqual(firstRetry);
    expect(first.items).toHaveLength(3);
    expect(second.items).toHaveLength(3);
    expect(third.items).toHaveLength(1);
    expect([...first.items, ...second.items, ...third.items].map((item) => item.caseId)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
    ]);
    expect(first.items[0]).toMatchObject({
      verdict: 'pass',
      score: 1,
      metricCounts: { expected: 1, evaluated: 1, passed: 1, errors: 0 },
    });
    expect(first.items[1]).toMatchObject({
      verdict: 'fail',
      score: 0,
      metricCounts: { expected: 1, evaluated: 1, passed: 0, errors: 0 },
    });
    expect(first.items[2]).toMatchObject({
      verdict: 'error',
      metricCounts: { expected: 1, evaluated: 0, passed: 0, errors: 0 },
    });
    for (const summary of [...first.items, ...second.items, ...third.items]) {
      expect(summary).not.toHaveProperty('request');
      expect(summary).not.toHaveProperty('response');
      expect(summary).not.toHaveProperty('trace');
    }
    await expect(store.getCase(run.id, 'suite', 'one')).resolves.toMatchObject({ caseId: 'one' });
    await expect(store.getCase(run.id, 'suite', 'missing')).rejects.toMatchObject({
      code: 'CASE_NOT_FOUND',
    });
    await expect(store.getCase('missing-run', 'suite', 'one')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  it('rejects unknown and foreign summary cursors plus invalid limits', async () => {
    const { store } = await openTemporaryStore();
    const firstRun = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const secondRun = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    for (const caseId of ['one', 'two']) {
      await store.recordCase(secondRun.id, completedExecution({ runId: secondRun.id, caseId }), []);
    }
    const foreignCursor = (await store.listCaseSummaries(secondRun.id, { limit: 1 })).nextCursor;
    expect(foreignCursor).toBeDefined();
    await expect(
      store.listCaseSummaries(firstRun.id, { cursor: foreignCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(store.listCaseSummaries(firstRun.id, { cursor: 'unknown' })).rejects.toMatchObject(
      { code: 'INVALID_CURSOR' },
    );
    for (const limit of [0, -1, 1.5, 1_001]) {
      await expect(store.listCaseSummaries(firstRun.id, { limit })).rejects.toMatchObject({
        code: 'INVALID_LIMIT',
      });
    }
  });
});

describe('RunStore adversarial persistence', () => {
  it('treats explicitly undefined forbidden fields like omitted JSON properties', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    const completed = {
      ...completedExecution({ runId: run.id, caseId: 'completed-with-undefined' }),
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
      ...completedExecution({ runId: run.id, caseId: 'failed-with-undefined' }),
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
      ...completedExecution({ runId: run.id, caseId: 'invalid' }),
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
          { ...completedExecution({ runId: run.id, caseId: caseId }), durationMs: index },
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
    const execution = completedExecution({ runId: run.id, caseId: 'rolled-back' });
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
    await store.recordCase(run.id, completedExecution({ runId: run.id, caseId: 'corrupt' }), []);
    const handle = await openSqliteHandle(path);
    await handle.prepare('UPDATE cases SET request_json = ? WHERE run_id = ?').run('{', run.id);
    await handle.close();

    const failure = await captureRejection(store.getCaseResults(run.id));
    expect(failure).toMatchObject({ code: 'CORRUPT_DATA' });
    expect(failure).toBeInstanceOf(StoreError);
    if (failure instanceof StoreError) expect(failure.cause).toBeInstanceOf(SyntaxError);
  });

  it('blocks raw Kysely mutations after a run is finalized', async () => {
    const { path, store } = await openTemporaryStore();
    const run = await store.createRun({
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
    });
    await store.recordCase(run.id, completedExecution({ runId: run.id, caseId: 'immutable' }), [
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
