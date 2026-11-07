import { valueFromExit } from './native-root.js';
import * as Effect from 'effect/Effect';
import {
  createSingleProjectCatalog,
  StoreError,
  summarizeCaseRecord,
  type RunSource,
} from '@attest/core';
import type { CaseRecord, RunRecord } from '@attest/core/records';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../server/create-api-app.js';
import { createApiClient } from '../api-client.js';

const project = { key: 'demo', name: 'Demo' };

const projectKey = project.key;

const run: RunRecord = {
  id: 'run',
  schemaId: 'attest.project',
  configHash: 'hash',
  configJson: '{}',
  createdAt: '2026-10-18T00:00:00.000Z',
  status: 'completed',
  finishedAt: '2026-10-18T00:00:01.000Z',
  gitBranch: 'main',
  gitSha: 'sha',
};

const records: CaseRecord[] = [10, 20, 30].map((durationMs) => ({
  rowId: String(durationMs),
  runId: run.id,
  suiteName: durationMs === 30 ? 'z' : 'a/b',
  caseId: String(durationMs),
  inputHash: 'hash',
  outcome: 'completed',
  startedAt: run.createdAt,
  durationMs,
  request: {
    protocol: 'attest.agent-invocation',
    run_id: run.id,
    case_id: String(durationMs),
    input: {},
  },
  response: { output: 'ok' },
  attempts: [],
  warnings: [],
  diagnostics: {},
  expectedMetrics: [],
  metrics: [],
}));

const cases = records.map((record) => ({ record, summary: summarizeCaseRecord(record) }));

const aggregate = {
  caseCount: 2,
  verdicts: { pass: 2, fail: 0, error: 0 },
  passRate: 1,
  scoredCaseCount: 0,
  meanScore: null,
  durationMs: { p50: 10, p95: 20 },
  metricErrorCount: 0,
};

const point = {
  runId: run.id,
  createdAt: run.createdAt,
  status: run.status,
  gitBranch: run.gitBranch,
  gitSha: run.gitSha,
  aggregate,
};

const source: RunSource = {
  listRuns: (query) => Effect.succeed({ items: query?.cursor === undefined ? [run] : [] }),
  getRun: (runId) =>
    Effect.gen(function* () {
      if (runId !== run.id)
        return yield* Effect.fail(new StoreError('RUN_NOT_FOUND', 'Run missing.'));

      return yield* Effect.succeed(run);
    }),
  listCaseSummaries: (runId, query) =>
    Effect.gen(function* () {
      yield* source.getRun(runId);

      const index =
        query?.cursor === undefined
          ? 0
          : cases.findIndex(({ record }) => record.rowId === query.cursor) + 1;

      const page = cases.slice(index, index + 1);

      return index + 1 < cases.length
        ? { items: page.map(({ summary }) => summary), nextCursor: page.at(-1)?.record.rowId }
        : { items: page.map(({ summary }) => summary) };
    }),
  getCase: () =>
    Effect.gen(function* () {
      return yield* Effect.fail(new StoreError('CASE_NOT_FOUND', 'No case reads in this fixture.'));
    }),
  getRunWithCases: () => Effect.succeed({ run, cases: records }),
};

afterEach(() => vi.unstubAllGlobals());

describe('suite analytics clients', () => {
  it('round-trips aggregates and encoded suite history with its query and abort signal', async () => {
    const app = new Hono().route(
      '/api',
      createApiApp({ catalog: createSingleProjectCatalog(project, source) }),
    );

    const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];

    const client = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      capabilities: { control: false },
      fetch: (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          signal: init?.signal,
        });

        return Promise.resolve(app.request(input, init));
      },
    });

    const controller = new AbortController();
    expect(
      await Effect.runPromiseExit(
        client.listRunSuites({ projectKey, runId: run.id }, { signal: controller.signal }),
      ).then(valueFromExit),
    ).toMatchObject({
      runId: run.id,
      suites: [
        { suiteName: 'a/b', ...aggregate },
        { suiteName: 'z', caseCount: 1 },
      ],
    });
    expect(
      await Effect.runPromiseExit(
        client.getSuiteHistory(
          { projectKey, suiteName: 'a/b' },
          { limit: 1 },
          { signal: controller.signal },
        ),
      ).then(valueFromExit),
    ).toEqual({
      suiteName: 'a/b',
      runsExamined: 1,
      exhausted: true,
      points: [point],
    });
    expect(requests).toMatchObject([
      { url: '/api/projects/demo/runs/run/suites', signal: requests[0]?.signal },
      { url: '/api/projects/demo/suites/a%2Fb/history?limit=1', signal: requests[1]?.signal },
    ]);
    expect(requests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    controller.abort();
    expect(requests.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(
      await Effect.runPromiseExit(
        client.getSuiteHistory({ projectKey, suiteName: 'absent' }, {}),
      ).then(valueFromExit),
    ).toEqual({
      suiteName: 'absent',
      runsExamined: 1,
      exhausted: true,
      points: [],
    });
    await expect(
      Effect.runPromiseExit(client.listRunSuites({ projectKey, runId: 'missing' })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: 'RUN_NOT_FOUND',
    });
  });

  it('parses both analytics response bodies through the contract', async () => {
    const client = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      capabilities: { control: false },
      fetch: () => Promise.resolve(Response.json({})),
    });

    await expect(
      Effect.runPromiseExit(client.listRunSuites({ projectKey, runId: run.id })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    await expect(
      Effect.runPromiseExit(client.getSuiteHistory({ projectKey, suiteName: 'a/b' }, {})).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('rejects invalid history limits with the same error in both client modes', async () => {
    const app = new Hono().route(
      '/api',
      createApiApp({ catalog: createSingleProjectCatalog(project, source) }),
    );

    const clients = [
      createApiClient({
        kind: 'http',
        baseUrl: '/api',
        capabilities: { control: false },
        fetch: (input, init) => Promise.resolve(app.request(input, init)),
      }),
      createApiClient({
        kind: 'snapshot',
        snapshot: { generatedAt: run.createdAt, project, run, cases, truncated: false },
      }),
    ];

    for (const client of clients) {
      for (const limit of [0, 51, 1.5]) {
        await expect(
          Effect.runPromiseExit(
            client.getSuiteHistory({ projectKey, suiteName: 'a/b' }, { limit }),
          ).then(valueFromExit),
        ).rejects.toMatchObject({
          name: 'ApiError',
          status: 400,
          code: 'INVALID_REQUEST',
        });
      }
    }
  });

  it('aggregates only embedded cases and omits running or absent suites from offline history', async () => {
    const network = vi.fn(() => Promise.reject(new Error('Snapshot touched fetch.')));
    vi.stubGlobal('fetch', network);

    const snapshot = {
      generatedAt: run.createdAt,
      project,
      run,
      cases: cases.slice(0, 2),
      truncated: true,
    };

    const client = createApiClient({ kind: 'snapshot', snapshot });
    expect(
      await Effect.runPromiseExit(client.listRunSuites({ projectKey, runId: run.id })).then(
        valueFromExit,
      ),
    ).toEqual({
      runId: run.id,
      suites: [{ suiteName: 'a/b', ...aggregate }],
    });
    expect(
      await Effect.runPromiseExit(
        client.getSuiteHistory({ projectKey, suiteName: 'a/b' }, { limit: 1 }),
      ).then(valueFromExit),
    ).toEqual({
      suiteName: 'a/b',
      runsExamined: 1,
      exhausted: true,
      points: [point],
    });
    expect(
      await Effect.runPromiseExit(
        client.getSuiteHistory({ projectKey, suiteName: 'z' }, { limit: 50 }),
      ).then(valueFromExit),
    ).toEqual({
      suiteName: 'z',
      runsExamined: 1,
      exhausted: true,
      points: [],
    });
    await expect(
      Effect.runPromiseExit(client.listRunSuites({ projectKey, runId: 'missing' })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: 'RUN_NOT_FOUND',
    });

    const running = createApiClient({
      kind: 'snapshot',
      snapshot: { ...snapshot, run: { ...run, status: 'running', finishedAt: undefined } },
    });

    expect(
      await Effect.runPromiseExit(
        running.getSuiteHistory({ projectKey, suiteName: 'a/b' }, {}),
      ).then(valueFromExit),
    ).toEqual({
      suiteName: 'a/b',
      runsExamined: 0,
      exhausted: true,
      points: [],
    });
    expect(
      await Effect.runPromiseExit(running.listRunSuites({ projectKey, runId: run.id })).then(
        valueFromExit,
      ),
    ).toEqual({
      runId: run.id,
      suites: [{ suiteName: 'a/b', ...aggregate }],
    });
    expect(network).not.toHaveBeenCalled();
  });
});
