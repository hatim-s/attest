import { createSingleProjectCatalog, StoreError, type RunSource } from '@attest/core';
import { parsePageLimit, type CaseSummary, type RunRecord } from '@attest/core/records';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { apiResponses } from '../../contract/responses.js';
import { createApiApp } from '../create-api-app.js';

const runs: RunRecord[] = (
  [
    ['running', 'running'],
    ['absent', 'completed'],
    ['new', 'completed'],
    ['running-older', 'running'],
    ['old', 'failed'],
    ['last', 'completed'],
  ] as const
).map(([id, status]) => ({
  id,
  status,
  schemaId: 'attest.project',
  configHash: id,
  configJson: '{}',
  createdAt: `2026-10-18T00:00:00.000Z`,
  gitBranch: 'main',
  gitSha: id,
}));

const summary = (
  suiteName: string,
  verdict: CaseSummary['verdict'],
  durationMs: number,
): CaseSummary => ({
  caseId: `${suiteName}-${durationMs}`,
  suiteName,
  verdict,
  outcome: 'completed',
  startedAt: '2026-10-18T00:00:00.000Z',
  durationMs,
  metricCounts: { expected: 0, evaluated: 0, passed: 0, errors: 0 },
});

const suites = new Map<string, CaseSummary[]>([
  ['running', [summary('z', 'pass', 1), summary('a/b', 'pass', 10), summary('a/b', 'error', 20)]],
  ['absent', [summary('other', 'pass', 1)]],
  ['new', [summary('a/b', 'pass', 10), summary('other', 'pass', 1), summary('a/b', 'fail', 20)]],
  ['old', [summary('a/b', 'error', 30)]],
  ['last', []],
]);

const fixture = (sourceRuns = runs) => {
  const caseReads: { runId: string; cursor?: string; limit?: number }[] = [];

  const source: RunSource = {
    listRuns: (query = {}) => {
      const limit = parsePageLimit(query);

      const start =
        query.cursor === undefined ? 0 : sourceRuns.findIndex((run) => run.id === query.cursor) + 1;

      const items = sourceRuns.slice(start, start + Math.min(limit, 2));

      return Promise.resolve(
        start + items.length < sourceRuns.length
          ? { items, nextCursor: items.at(-1)?.id }
          : { items },
      );
    },
    getRun: (runId) => {
      const run = runs.find((run) => run.id === runId);

      if (run === undefined) throw new StoreError('RUN_NOT_FOUND', `Run ${runId} missing.`);

      return Promise.resolve(run);
    },
    listCaseSummaries: async (runId, query = {}) => {
      await source.getRun(runId);
      caseReads.push({ runId, ...query });
      const items = suites.get(runId) ?? [];
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const page = items.slice(start, start + 1);

      return start + 1 < items.length
        ? { items: page, nextCursor: String(start + 1) }
        : { items: page };
    },
    getCase: () => {
      throw new StoreError('CASE_NOT_FOUND', 'No case blobs in this fixture.');
    },
    getRunWithCases: async (runId) => ({ run: await source.getRun(runId), cases: [] }),
  };

  return {
    app: new Hono().route(
      '/api',
      createApiApp({ catalog: createSingleProjectCatalog({ key: 'demo', name: 'Demo' }, source) }),
    ),
    caseReads,
  };
};

describe('suite analytics endpoints', () => {
  it('aggregates every case page of a running run and preserves missing-run errors', async () => {
    const { app, caseReads } = fixture();
    const response = await app.request('/api/projects/demo/runs/running/suites');
    expect(response.status).toBe(200);
    const body = apiResponses.listRunSuites.parse(await response.json());
    expect(body).toMatchObject({
      runId: 'running',
      suites: [
        {
          suiteName: 'a/b',
          caseCount: 2,
          verdicts: { pass: 1, fail: 0, error: 1 },
          passRate: 0.5,
          durationMs: { p50: 10, p95: 20 },
        },
        { suiteName: 'z', caseCount: 1 },
      ],
    });
    expect(caseReads).toEqual([
      { runId: 'running', limit: 1000 },
      { runId: 'running', cursor: '1', limit: 1000 },
      { runId: 'running', cursor: '2', limit: 1000 },
    ]);
    const missing = await app.request('/api/projects/demo/runs/missing/suites');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'RUN_NOT_FOUND', message: 'Run missing missing.' },
    });
    expect(await (await app.request('/api/projects/demo/runs/last/suites')).json()).toEqual({
      runId: 'last',
      suites: [],
    });
  });

  it('skips running runs, counts absent suites toward the limit and keeps newest-first points', async () => {
    const { app, caseReads } = fixture();
    const response = await app.request('/api/projects/demo/suites/a%2Fb/history?limit=2');
    expect(response.status).toBe(200);
    const history = apiResponses.getSuiteHistory.parse(await response.json());
    expect(history).toMatchObject({
      suiteName: 'a/b',
      runsExamined: 2,
      exhausted: false,
      points: [
        {
          runId: 'new',
          status: 'completed',
          gitBranch: 'main',
          gitSha: 'new',
          aggregate: { caseCount: 2, passRate: 0.5 },
        },
      ],
    });
    expect(history.points).toHaveLength(1);
    expect([...new Set(caseReads.map(({ runId }) => runId))]).toEqual(['absent', 'new']);

    const exhausted = apiResponses.getSuiteHistory.parse(
      await (await app.request('/api/projects/demo/suites/a%2Fb/history')).json(),
    );

    expect(exhausted.exhausted).toBe(true);
    expect(exhausted.runsExamined).toBe(4);
    expect(exhausted.points.map((point) => point.runId)).toEqual(['new', 'old']);
    expect(
      await (await app.request('/api/projects/demo/suites/unknown/history?limit=1')).json(),
    ).toEqual({
      suiteName: 'unknown',
      runsExamined: 1,
      exhausted: false,
      points: [],
    });
  });

  it('distinguishes reaching the limit from exhausting the source', async () => {
    const { app } = fixture(runs.filter((run) => run.status === 'completed'));

    for (const [limit, exhausted, runsExamined] of [
      [2, false, 2],
      [5, true, 3],
      [3, true, 3],
    ] as const) {
      const response = await app.request(`/api/projects/demo/suites/a%2Fb/history?limit=${limit}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ exhausted, runsExamined });
    }
  });

  it('rejects invalid history limits before reading cases', async () => {
    const { app, caseReads } = fixture();

    for (const limit of ['0', '51', '1.5', 'nope', '']) {
      const response = await app.request(`/api/projects/demo/suites/a%2Fb/history?limit=${limit}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }

    expect(caseReads).toEqual([]);
  });
});
