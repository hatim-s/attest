import * as Effect from 'effect/Effect';
import { StoreError, type ProjectCatalog, type RunSource } from '@attest/core';
import type { ProjectRecord } from '@attest/core/records';
import { describe, expect, it } from 'vitest';

import { createApiApp } from '../create-api-app.js';

const overview = {
  evals: { items: [] },
  runningRunCount: 0,
  runningRunCountTruncated: false,
  lastRunAt: null,
};

const activity = {
  coveredFrom: '2026-10-01T00:00:00.000Z',
  coveredTo: '2026-10-15T00:00:00.000Z',
  timezone: 'UTC' as const,
  days: [],
  truncated: false,
};

/** Records what each dashboard read received so routes are checked against the source contract. */
const recordingSource = () => {
  const calls: unknown[][] = [];
  const unused = () => Effect.die(new Error('Not a dashboard read.'));

  const source: RunSource = {
    getProjectOverview: () => Effect.succeed(overview),
    listEvals: (query) => (calls.push(['listEvals', query]), Effect.succeed({ items: [] })),
    listEvalRuns: (suiteName, query) => (
      calls.push(['listEvalRuns', suiteName, query]),
      Effect.succeed({ items: [] })
    ),
    getEvalCaseWindow: (suiteName, query) => (
      calls.push(['getEvalCaseWindow', suiteName, query]),
      Effect.succeed({ runs: [], items: [] })
    ),
    getCaseHistory: (suiteName, caseId, query) => (
      calls.push(['getCaseHistory', suiteName, caseId, query]),
      Effect.succeed({ items: [] })
    ),
    getActivity: (query) => (calls.push(['getActivity', query]), Effect.succeed(activity)),
    listRunSuites: (runId) => (calls.push(['listRunSuites', runId]), Effect.succeed([])),
    listCaseSummaries: (runId, query) => (
      calls.push(['listCaseSummaries', runId, query]),
      Effect.succeed({ items: [] })
    ),
    listRuns: unused,
    getRun: unused,
    getCase: unused,
    getRunWithCases: unused,
  };

  return { source, calls };
};

const projects: ProjectRecord[] = [
  { key: 'ready', name: 'Ready' },
  { key: 'outdated', name: 'Outdated' },
  { key: 'broken', name: 'Broken' },
];

const catalogFor = (source: RunSource): ProjectCatalog => ({
  listProjects: () => Effect.succeed(projects),
  openProject: (key) => {
    if (key === 'ready') return Effect.succeed(source);

    if (key === 'outdated')
      return Effect.fail(new StoreError('SCHEMA_OUTDATED', 'Run store schema version 1 is older.'));

    return Effect.succeed({
      ...source,
      getProjectOverview: () => Effect.fail(new StoreError('CORRUPT_DATA', 'Bad totals row.')),
    });
  },
});

const request = async (path: string) => {
  const { source, calls } = recordingSource();
  const response = await createApiApp({ catalog: catalogFor(source) }).request(path);

  const body: unknown = await response.json();

  return { status: response.status, body, calls };
};

describe('dashboard routes', () => {
  it('lists every catalog project in order, with an error entry for each unreadable store', async () => {
    const { status, body } = await request('/overview');

    expect(status).toBe(200);
    expect(body).toEqual({
      items: [
        { status: 'ready', project: projects[0], overview },
        {
          status: 'error',
          project: projects[1],
          error: { code: 'SOURCE_UNREADABLE', message: 'Run store schema version 1 is older.' },
        },
        {
          status: 'error',
          project: projects[2],
          error: { code: 'SOURCE_UNREADABLE', message: 'Bad totals row.' },
        },
      ],
    });
  });

  it('passes decoded params and queries through to the source', async () => {
    const suite = encodeURIComponent('a/b');

    const reads = [
      `/projects/ready/evals?limit=5&cursor=a`,
      `/projects/ready/evals/${suite}/runs?limit=3&cursor=r1&since=2026-10-01T00:00:00Z&until=2026-10-15T00:00:00Z`,
      `/projects/ready/evals/${suite}/cases?limit=2`,
      `/projects/ready/evals/${suite}/cases/${encodeURIComponent('c/1')}/history?cursor=r2`,
      `/projects/ready/activity?from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z`,
      `/projects/ready/runs/r1/suites`,
      `/projects/ready/runs/r1/cases?suiteName=${suite}&limit=7`,
    ];

    const calls = [];

    for (const path of reads) {
      const result = await request(path);
      expect(result.status, path).toBe(200);
      calls.push(...result.calls);
    }

    expect(calls).toEqual([
      ['listEvals', { limit: 5, cursor: 'a' }],
      [
        'listEvalRuns',
        'a/b',
        {
          limit: 3,
          cursor: 'r1',
          since: '2026-10-01T00:00:00Z',
          until: '2026-10-15T00:00:00Z',
        },
      ],
      ['getEvalCaseWindow', 'a/b', { limit: 2 }],
      ['getCaseHistory', 'a/b', 'c/1', { limit: 100, cursor: 'r2' }],
      ['getActivity', { from: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }],
      ['listRunSuites', 'r1'],
      ['listCaseSummaries', 'r1', { limit: 7, suiteName: 'a/b' }],
    ]);
  });

  it('rejects malformed dashboard queries before they reach the source', async () => {
    for (const path of [
      '/projects/ready/evals?limit=0',
      '/projects/ready/evals/a/runs?limit=1001',
      '/projects/ready/activity?from=2026-10-01T00:00:00Z',
      '/projects/ready/runs/r1/cases?suiteName=',
    ]) {
      const { status, body, calls } = await request(path);

      expect(status, path).toBe(400);
      expect(body, path).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect(calls, path).toEqual([]);
    }
  });

  it('no longer serves suite history', async () => {
    const { status, body } = await request('/projects/ready/suites/a/history');

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  });
});
