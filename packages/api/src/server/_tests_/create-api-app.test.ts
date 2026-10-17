import { diffRuns, StoreError, summarizeCaseRecord, type RunSource } from '@attest/core';
import type { CaseRecord, RunRecord } from '@attest/core/records';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApiApp } from '../create-api-app.js';

const runs: RunRecord[] = ['candidate', 'base'].map((id) => ({
  id,
  schemaId: 'attest.project',
  configHash: id,
  configJson: '{}',
  createdAt: '2026-10-18T00:00:00.000Z',
  status: 'running',
}));

const cases: CaseRecord[] = [
  {
    rowId: 'row-1',
    runId: 'candidate',
    suiteName: 'a/b',
    caseId: 'one',
    inputHash: 'input',
    outcome: 'completed',
    startedAt: '2026-10-18T00:00:00.000Z',
    durationMs: 10,
    request: {
      protocol: 'attest.agent-invocation',
      run_id: 'candidate',
      case_id: 'one',
      input: {},
    },
    response: { output: 'ok' },
    attempts: [],
    warnings: [],
    diagnostics: {},
    expectedMetrics: [],
    metrics: [],
  },
];

const source: RunSource = {
  listRuns: () => Promise.resolve({ items: runs }),
  getRun: (runId) => {
    const run = runs.find((run) => run.id === runId);

    if (run === undefined) throw new StoreError('RUN_NOT_FOUND', `Run ${runId} missing.`);

    return Promise.resolve(run);
  },
  listCaseSummaries: (runId) =>
    Promise.resolve({
      items: cases.flatMap((record) =>
        record.runId === runId ? [summarizeCaseRecord(record)] : [],
      ),
    }),
  getCase: (runId, suiteName, caseId) => {
    const record = cases.find(
      (record) =>
        record.runId === runId && record.suiteName === suiteName && record.caseId === caseId,
    );

    if (record === undefined) throw new StoreError('CASE_NOT_FOUND', 'Case missing.');

    return Promise.resolve(record);
  },
  getRunWithCases: async (runId) => ({
    run: await source.getRun(runId),
    cases: cases.filter((record) => record.runId === runId),
  }),
};

describe('createApiApp', () => {
  it('serves every source projection and comparisons when mounted', async () => {
    const app = new Hono().route('/api', createApiApp({ source }));

    const expectations = [
      ['/runs', { items: runs }],
      ['/runs/candidate', runs[0]],
      ['/runs/candidate/cases', { items: cases.map(summarizeCaseRecord) }],
      ['/runs/candidate/cases/a%2Fb/one', cases[0]],
      ['/diffs/base/candidate', await diffRuns(source, 'base', 'candidate')],
    ] as const;

    for (const [path, body] of expectations) {
      const response = await app.request(`/api${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
    }

    const missing = await app.request('/api/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' },
    });
  });

  it('parses paging once and rejects invalid limits or equal comparison ids', async () => {
    const received: unknown[] = [];

    const app = createApiApp({
      source: {
        ...source,
        listRuns: (query) => {
          received.push(query);

          return Promise.resolve({ items: [] });
        },
      },
    });

    await app.request('/runs?cursor=anchor&limit=2');
    await app.request('/runs');
    expect(received).toEqual([{ cursor: 'anchor', limit: 2 }, { limit: 100 }]);

    for (const path of [
      '/runs?limit=0',
      '/runs?limit=1001',
      '/runs?limit=1.5',
      '/diffs/base/base',
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }

    expect(received).toHaveLength(2);
  });

  it.each([
    [new StoreError('RUN_NOT_FOUND', 'Run missing.'), 404, 'RUN_NOT_FOUND', 'Run missing.'],
    [new StoreError('CASE_NOT_FOUND', 'Case missing.'), 404, 'CASE_NOT_FOUND', 'Case missing.'],
    [new StoreError('INVALID_CURSOR', 'Cursor missing.'), 400, 'INVALID_CURSOR', 'Cursor missing.'],
    [new StoreError('INVALID_LIMIT', 'Bad limit.'), 400, 'INVALID_REQUEST', 'Bad limit.'],
    [
      new StoreError('CORRUPT_DATA', 'Unreadable row.'),
      500,
      'SOURCE_UNREADABLE',
      'Unreadable row.',
    ],
    [
      new StoreError('WRITE_FAILED', 'private details'),
      500,
      'INTERNAL_ERROR',
      'The API could not complete the request.',
    ],
    [
      new Error('private details'),
      500,
      'INTERNAL_ERROR',
      'The API could not complete the request.',
    ],
  ] as const)('maps %s to an actionable envelope', async (error, status, code, message) => {
    const app = createApiApp({
      source: {
        ...source,
        listRuns: () => {
          throw error;
        },
      },
    });

    const response = await app.request('/runs');
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message } });
  });
});
