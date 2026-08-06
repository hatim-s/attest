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
  const directory = await mkdtemp(join(tmpdir(), 'attest-run-store-'));
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
  input: { zeta: 2, alpha: 'input' },
  params: { temperature: 0 },
});

const trace: Trace = {
  schema: TRACE_SCHEMA_VERSION,
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
      attributes: {
        'gen_ai.tool.name': 'web_search',
        'gen_ai.request.model': 'attest-model',
      },
    },
  ],
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('RunStore', () => {
  it('round-trips all run, case, metric, warning, response, and trace fields', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'attest.config/v1alpha1',
      configHash: 'config-hash',
      configJson: '{"suite":"round-trip"}',
      gitSha: 'abc123',
      gitBranch: 'main',
      labels: { environment: 'test' },
    });
    const execution: StoredCaseExecution = {
      caseId: 'case-1',
      suiteName: 'suite-1',
      outcome: 'completed',
      startedAt: '2026-08-06T01:02:03.000Z',
      durationMs: 125,
      request: request(run.id, 'case-1'),
      response: { output: 'ok', vendor_extension: { nested: true } },
      responseWarnings: [
        { path: 'vendor_extension', message: 'unknown field preserved', code: 'unknown_field' },
      ],
      invocationError: {
        kind: 'nonzero_exit',
        message: 'captured for diagnostics',
        exitCode: 7,
        stderrExcerpt: 'failure excerpt',
      },
      trace,
    };
    const evaluation: StoredMetricEvaluation = {
      metricName: 'quality',
      kind: 'judge',
      status: 'evaluated',
      score: 0.9,
      pass: true,
      rationale: 'meets the rubric',
      details: { dimensions: ['correctness'] },
      error: { message: 'retained diagnostic', kind: 'judge_warning' },
      judgeIo: { request: 'rubric', response: { unknown: 'preserved' } },
      durationMs: 42,
    };

    await store.recordCase(run.id, execution, [evaluation]);
    const finalized = await store.finalizeRun(run.id, 'completed');
    const [storedCase] = await store.getCaseResults(run.id);

    expect(await store.getRun(run.id)).toEqual(finalized);
    expect(finalized).toMatchObject({
      ...run,
      status: 'completed',
      summary: {
        totalCases: 1,
        passedCases: 1,
        failedCases: 0,
        errorCases: 0,
        metricErrorCount: 0,
      },
    });
    expect(finalized.finishedAt).toBeDefined();
    expect(storedCase).toMatchObject({ ...execution, runId: run.id, metrics: [evaluation] });
    expect(storedCase?.rowId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('computes mixed pass, fail, invocation-error, and metric-error totals', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    const cases: Array<[StoredCaseExecution, StoredMetricEvaluation[]]> = [
      [
        {
          caseId: 'pass',
          suiteName: 'suite',
          outcome: 'completed',
          startedAt: '2026-08-06T00:00:00.000Z',
          durationMs: 1,
          request: request(run.id, 'pass'),
        },
        [{ metricName: 'metric', kind: 'assertion', status: 'evaluated', pass: true }],
      ],
      [
        {
          caseId: 'fail',
          suiteName: 'suite',
          outcome: 'completed',
          startedAt: '2026-08-06T00:00:01.000Z',
          durationMs: 1,
          request: request(run.id, 'fail'),
        },
        [{ metricName: 'metric', kind: 'assertion', status: 'evaluated', pass: false }],
      ],
      [
        {
          caseId: 'error',
          suiteName: 'suite',
          outcome: 'timeout',
          startedAt: '2026-08-06T00:00:02.000Z',
          durationMs: 1,
          request: request(run.id, 'error'),
        },
        [
          {
            metricName: 'metric',
            kind: 'judge',
            status: 'error',
            error: { message: 'timeout', kind: 'timeout' },
          },
        ],
      ],
    ];
    for (const [execution, evaluations] of cases) {
      await store.recordCase(run.id, execution, evaluations);
    }

    const finalized = await store.finalizeRun(run.id, 'failed');
    expect(finalized.summary).toEqual({
      totalCases: 3,
      passedCases: 1,
      failedCases: 1,
      errorCases: 1,
      metricErrorCount: 1,
    });
  });

  it('rejects double finalization with RUN_FINALIZED', async () => {
    const { store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    await store.finalizeRun(run.id, 'completed');

    await expect(store.finalizeRun(run.id, 'failed')).rejects.toMatchObject({
      code: 'RUN_FINALIZED',
    });
  });

  it('reports RUN_NOT_FOUND for unknown runs', async () => {
    const { store } = await openTemporaryStore();
    await expect(store.getRun('missing')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
    await expect(store.getCaseResults('missing')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  it('denormalizes tool and model span attributes', async () => {
    const { path, store } = await openTemporaryStore();
    const run = await store.createRun({
      configVersion: 'v1',
      configHash: 'hash',
      configJson: '{}',
    });
    await store.recordCase(
      run.id,
      {
        caseId: 'traced',
        suiteName: 'suite',
        outcome: 'completed',
        startedAt: '2026-08-06T00:00:00.000Z',
        durationMs: 1,
        request: request(run.id, 'traced'),
        trace,
      },
      [],
    );

    const handle = await openSqliteHandle(path);
    const [span] = await handle
      .prepare(
        'SELECT span_id, kind, name, start_time, end_time, status, tool_name, model_name FROM spans',
      )
      .all();
    await handle.close();
    expect(span).toMatchObject({
      span_id: 'span-1',
      kind: 'tool',
      name: 'search',
      start_time: '2026-08-06T01:02:03.000Z',
      end_time: '2026-08-06T01:02:04.000Z',
      status: 'ok',
      tool_name: 'web_search',
      model_name: 'attest-model',
    });
  });

  it('lists runs newest first and respects limit', async () => {
    const { store } = await openTemporaryStore();
    const first = await store.createRun({ configVersion: 'v1', configHash: '1', configJson: '{}' });
    const second = await store.createRun({
      configVersion: 'v1',
      configHash: '2',
      configJson: '{}',
    });
    const third = await store.createRun({ configVersion: 'v1', configHash: '3', configJson: '{}' });

    expect((await store.listRuns()).map((run) => run.id)).toEqual([third.id, second.id, first.id]);
    expect((await store.listRuns({ limit: 2 })).map((run) => run.id)).toEqual([
      third.id,
      second.id,
    ]);
  });
});
