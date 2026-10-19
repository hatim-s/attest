import {
  createSingleProjectCatalog,
  diffRuns,
  StoreError,
  summarizeCaseRecord,
  type ProjectCatalog,
  type RunControl,
  type RunSource,
} from '@attest/core';
import type { CaseRecord, RunRecord, RunStartRequest } from '@attest/core/records';
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

const project = { key: 'demo', name: 'Demo', root: '/work/demo' };

const catalogFor = (runSource: RunSource): ProjectCatalog =>
  createSingleProjectCatalog(project, runSource);

describe('createApiApp', () => {
  it('serves every source projection and comparisons when mounted', async () => {
    const app = new Hono().route('/api', createApiApp({ catalog: catalogFor(source) }));

    const expectations = [
      ['/projects', { items: [project] }],
      ['/projects/demo/runs', { items: runs }],
      ['/projects/demo/runs/candidate', runs[0]],
      ['/projects/demo/runs/candidate/cases', { items: cases.map(summarizeCaseRecord) }],
      ['/projects/demo/runs/candidate/cases/a%2Fb/one', cases[0]],
      ['/projects/demo/diffs/base/candidate', await diffRuns(source, 'base', 'candidate')],
    ] as const;

    for (const [path, body] of expectations) {
      const response = await app.request(`/api${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
    }

    for (const path of ['/api/nope', '/api/runs']) {
      const missing = await app.request(path);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' },
      });
    }
  });

  it('opens the project once per request and rejects unknown or malformed keys', async () => {
    const opened: string[] = [];
    const single = catalogFor(source);

    const app = createApiApp({
      catalog: {
        listProjects: () => single.listProjects(),
        openProject: (key) => {
          opened.push(key);

          return single.openProject(key);
        },
      },
    });

    expect((await app.request('/projects/demo/diffs/base/candidate')).status).toBe(200);
    expect(opened).toEqual(['demo']);

    const unknown = await app.request('/projects/other/runs');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: 'PROJECT_NOT_FOUND', message: 'Project other is not served here.' },
    });

    const malformed = await app.request('/projects/Not_A_Key/runs');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(opened).toEqual(['demo', 'other']);
  });

  it('parses paging once and rejects invalid limits or equal comparison ids', async () => {
    const received: unknown[] = [];

    const app = createApiApp({
      catalog: catalogFor({
        ...source,
        listRuns: (query) => {
          received.push(query);

          return Promise.resolve({ items: [] });
        },
      }),
    });

    await app.request('/projects/demo/runs?cursor=anchor&limit=2');
    await app.request('/projects/demo/runs');
    expect(received).toEqual([{ cursor: 'anchor', limit: 2 }, { limit: 100 }]);

    for (const path of [
      '/projects/demo/runs?limit=0',
      '/projects/demo/runs?limit=1001',
      '/projects/demo/runs?limit=1.5',
      '/projects/demo/diffs/base/base',
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
      catalog: catalogFor({
        ...source,
        listRuns: () => {
          throw error;
        },
      }),
    });

    const response = await app.request('/projects/demo/runs');
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message } });
  });

  describe('run control', () => {
    const post = (
      app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
      path: string,
      body?: string,
    ) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

    /** A control that records what the routes hand it. */
    const recordingControl = () => {
      const started: { projectKey: string; request: RunStartRequest }[] = [];
      const cancelled: string[] = [];

      const control: RunControl = {
        listTests: () =>
          Promise.resolve([{ id: 'smoke', name: 'Smoke', tags: ['fast'], caseCount: 2 }]),
        startRun: (projectKey, request) => {
          started.push({ projectKey, request });

          if (request.tags?.includes('broken') === true) {
            throw new StoreError('RUN_START_FAILED', 'The run did not start.', {
              details: { code: 'project_invalid', message: 'Test smoke has no cases.' },
            });
          }

          return Promise.resolve({ runId: 'run-new' });
        },
        cancelRun: (_projectKey, runId) => {
          cancelled.push(runId);

          if (runId === 'missing') throw new StoreError('RUN_NOT_FOUND', 'Run missing.');

          return Promise.resolve({ outcome: 'cancellation_requested' });
        },
      };

      return { control, started, cancelled };
    };

    it('answers every control route with CONTROL_UNAVAILABLE when the host injects none', async () => {
      const app = createApiApp({ catalog: catalogFor(source) });

      const responses = [
        await app.request('/projects/demo/tests'),
        await post(app, '/projects/demo/runs', JSON.stringify({ selection: { all: true } })),
        await post(app, '/projects/demo/runs/candidate/cancel'),
      ];

      for (const response of responses) {
        expect(response.status).toBe(501);
        expect(await response.json()).toEqual({
          error: { code: 'CONTROL_UNAVAILABLE', message: 'This host cannot start or cancel runs.' },
        });
      }
    });

    it('lists tests, starts and cancels runs through the injected control', async () => {
      const { control, started, cancelled } = recordingControl();
      const app = new Hono().route('/api', createApiApp({ catalog: catalogFor(source), control }));

      const tests = await app.request('/api/projects/demo/tests');
      expect(tests.status).toBe(200);
      expect(await tests.json()).toEqual({
        items: [{ id: 'smoke', name: 'Smoke', tags: ['fast'], caseCount: 2 }],
      });

      const request = { selection: { testIds: ['smoke'] }, tags: ['fast'], concurrency: 2 };
      const start = await post(app, '/api/projects/demo/runs', JSON.stringify(request));
      expect(start.status).toBe(201);
      expect(await start.json()).toEqual({ runId: 'run-new' });
      expect(started).toEqual([{ projectKey: 'demo', request }]);

      const cancel = await post(app, '/api/projects/demo/runs/candidate/cancel');
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({ outcome: 'cancellation_requested' });

      const missing = await post(app, '/api/projects/demo/runs/missing/cancel');
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { code: 'RUN_NOT_FOUND', message: 'Run missing.' },
      });
      expect(cancelled).toEqual(['candidate', 'missing']);
    });

    it('rejects malformed start bodies before the control sees them', async () => {
      const { control, started } = recordingControl();
      const app = createApiApp({ catalog: catalogFor(source), control });

      for (const body of [
        undefined,
        '{',
        JSON.stringify({}),
        JSON.stringify({ selection: { all: false } }),
        JSON.stringify({ selection: { testIds: [] } }),
        JSON.stringify({ selection: { all: true, testIds: ['smoke'] } }),
        JSON.stringify({ selection: { all: true }, concurrency: 0 }),
        JSON.stringify({ selection: { all: true }, tags: [] }),
        JSON.stringify({ selection: { testIds: ['Smoke'] } }),
        JSON.stringify({ selection: { testIds: ['smoke', 'smoke'] } }),
        JSON.stringify({ selection: { all: true }, tags: ['fast', 'fast'] }),
      ]) {
        const response = await post(app, '/projects/demo/runs', body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      }

      expect(started).toEqual([]);
    });

    it('carries the CLI diagnostics of a run that did not start', async () => {
      const { control } = recordingControl();
      const app = createApiApp({ catalog: catalogFor(source), control });

      const response = await post(
        app,
        '/projects/demo/runs',
        JSON.stringify({ selection: { all: true }, tags: ['broken'] }),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          code: 'RUN_START_FAILED',
          message: 'The run did not start.',
          details: { code: 'project_invalid', message: 'Test smoke has no cases.' },
        },
      });
    });

    it('checks the project key before reaching the control', async () => {
      const { control, started } = recordingControl();
      const app = createApiApp({ catalog: catalogFor(source), control });

      const response = await post(
        app,
        '/projects/other/runs',
        JSON.stringify({ selection: { all: true } }),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
      expect(started).toEqual([]);
    });
  });
});
