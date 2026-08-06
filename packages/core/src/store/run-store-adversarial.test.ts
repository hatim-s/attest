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

import { openSqliteHandle } from './database.js';
import { openRunStore, type RunStore } from './run-store.js';
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

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('RunStore adversarial persistence', () => {
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
      {
        caseId: 'defensive-trace',
        suiteName: 'suite',
        outcome: 'completed',
        startedAt: '2026-08-06T00:00:00.000Z',
        durationMs: 1,
        request: request(run.id, 'defensive-trace'),
        trace: defensiveTrace,
      },
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
          {
            caseId,
            suiteName: 'suite',
            outcome: 'completed',
            startedAt: '2026-08-06T00:00:00.000Z',
            durationMs: index,
            request: request(run.id, caseId),
          },
          [{ metricName: 'quality', kind: 'assertion', status: 'evaluated', pass: true }],
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
    const execution: StoredCaseExecution = {
      caseId: 'rolled-back',
      suiteName: 'suite',
      outcome: 'completed',
      startedAt: '2026-08-06T00:00:00.000Z',
      durationMs: 1,
      request: request(run.id, 'rolled-back'),
    };
    const duplicateMetrics: StoredMetricEvaluation[] = [
      { metricName: 'duplicate', kind: 'assertion', status: 'evaluated', pass: true },
      { metricName: 'duplicate', kind: 'assertion', status: 'evaluated', pass: false },
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
    await store.recordCase(
      run.id,
      {
        caseId: 'corrupt',
        suiteName: 'suite',
        outcome: 'completed',
        startedAt: '2026-08-06T00:00:00.000Z',
        durationMs: 1,
        request: request(run.id, 'corrupt'),
      },
      [],
    );
    const handle = await openSqliteHandle(path);
    await handle.prepare('UPDATE cases SET request_json = ? WHERE run_id = ?').run('{', run.id);
    await handle.close();

    const failure = await store.getCaseResults(run.id).catch((error) => error);
    expect(failure).toMatchObject({ code: 'CORRUPT_DATA', cause: expect.any(SyntaxError) });
  });
});
