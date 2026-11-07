import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Context from 'effect/Context';
import * as Cause from 'effect/Cause';
import { valueFromExit } from './native-root.js';
import { readExitValue } from '../../server/error-response.js';
import * as Effect from 'effect/Effect';
import {
  createSingleProjectCatalog,
  diffRuns,
  StoreError,
  summarizeCaseRecord,
  type RunControl,
  type RunSource,
} from '@attest/core';
import type { CaseRecord, RunRecord } from '@attest/core/records';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../../server/create-api-app.js';
import { createApiClient, type ApiClient } from '../api-client.js';
import { ApiError } from '../api-error.js';

const runs: RunRecord[] = ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW'].map(
  (id) => ({
    id,
    schemaId: 'attest.project',
    configHash: id,
    configJson: '{}',
    createdAt: '2026-10-18T00:00:00.000Z',
    status: 'running',
  }),
);

const cases: CaseRecord[] = ['one', 'two'].map((caseId) => ({
  rowId: `row-${caseId}`,
  runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  suiteName: 'a/b',
  caseId,
  inputHash: 'input',
  outcome: 'completed',
  startedAt: '2026-10-18T00:00:00.000Z',
  durationMs: 10,
  request: {
    protocol: 'attest.agent-invocation',
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    case_id: caseId,
    input: {},
  },
  response: { output: 'ok' },
  attempts: [],
  warnings: [],
  diagnostics: {},
  expectedMetrics: [],
  metrics: [],
}));

const source: RunSource = {
  getProjectOverview: () =>
    Effect.succeed({
      evals: { items: [] },
      runningRunCount: 0,
      runningRunCountTruncated: false,
      lastRunAt: null,
    }),
  listEvals: () => Effect.succeed({ items: [] }),
  listEvalRuns: () => Effect.succeed({ items: [] }),
  getEvalCaseWindow: () => Effect.succeed({ runs: [], items: [] }),
  getCaseHistory: () => Effect.succeed({ items: [] }),
  getActivity: () =>
    Effect.succeed({
      coveredFrom: '2026-01-01T00:00:00.000Z',
      coveredTo: '2026-01-02T00:00:00.000Z',
      timezone: 'UTC',
      days: [],
      truncated: false,
    }),
  listRunSuites: () => Effect.succeed([]),

  listRuns: () => Effect.succeed({ items: runs }),
  getRun: (runId) =>
    Effect.gen(function* () {
      const run = runs.find((run) => run.id === runId);

      if (run === undefined)
        return yield* Effect.fail(new StoreError('RUN_NOT_FOUND', `Run ${runId} missing.`));

      return yield* Effect.succeed(run);
    }),
  listCaseSummaries: () => Effect.succeed({ items: cases.map(summarizeCaseRecord) }),
  getCase: (runId, suiteName, caseId) =>
    Effect.gen(function* () {
      const found = cases.find(
        (record) =>
          record.runId === runId && record.suiteName === suiteName && record.caseId === caseId,
      );

      if (found === undefined)
        return yield* Effect.fail(new StoreError('CASE_NOT_FOUND', 'Case missing.'));

      return yield* Effect.succeed(found);
    }),
  getRunWithCases: (runId) =>
    Effect.gen(function* () {
      return {
        run: yield* source.getRun(runId),
        cases: cases.filter((record) => record.runId === runId),
      };
    }),
};

const project = { key: 'demo', name: 'Demo', root: '/work/demo', projectId: 'project-1' };

const projectKey = project.key;

const reads = (client: ApiClient) => [
  () => Effect.runPromiseExit(client.listProjects()).then(valueFromExit),
  () => Effect.runPromiseExit(client.listRuns({ projectKey }, {})).then(valueFromExit),
  () =>
    Effect.runPromiseExit(client.getRun({ projectKey, runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).then(
      valueFromExit,
    ),
  () =>
    Effect.runPromiseExit(
      client.listCaseSummaries({ projectKey, runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, {}),
    ).then(valueFromExit),
  () =>
    Effect.runPromiseExit(
      client.getCase({
        projectKey,
        runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        suiteName: 'a/b',
        caseId: 'one',
      }),
    ).then(valueFromExit),
  () =>
    Effect.runPromiseExit(
      client.getDiff({
        projectKey,
        baseRunId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        candidateRunId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).then(valueFromExit),
];

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient', () => {
  it('round-trips every HTTP route including suite slashes, query and abort signal', async () => {
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

    const expected = [
      { items: [project] },
      { items: runs },
      runs[0],
      { items: cases.map(summarizeCaseRecord) },
      cases[0],
      readExitValue(
        await Effect.runPromiseExit(
          diffRuns(source, '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
        ),
      ),
    ];

    for (const [index, read] of reads(client).entries())
      expect(await read()).toEqual(expected[index]);
    const controller = new AbortController();
    await Effect.runPromiseExit(
      client.listRuns(
        { projectKey },
        { cursor: 'anchor', limit: 2 },
        { signal: controller.signal },
      ),
    ).then(valueFromExit);
    expect(requests.at(-1)).toMatchObject({
      url: '/api/projects/demo/runs?cursor=anchor&limit=2',
      signal: requests.at(-1)?.signal,
    });
    expect(requests.at(-1)?.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(requests.at(-1)?.signal?.aborted).toBe(true);
    expect(requests.map(({ url }) => url)).toContain(
      '/api/projects/demo/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV/cases/a%2Fb/one',
    );
    await expect(
      Effect.runPromiseExit(client.getRun({ projectKey: 'other', runId: 'missing' })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(
      Effect.runPromiseExit(client.getRun({ projectKey, runId: 'missing' })).then(valueFromExit),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'RUN_NOT_FOUND',
      message: 'Run missing missing.',
    });
  });

  it('rejects malformed success bodies on every route and non-JSON proxy errors', async () => {
    const client = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      capabilities: { control: false },
      fetch: () => Promise.resolve(Response.json({})),
    });

    for (const read of reads(client)) {
      await expect(read()).rejects.toMatchObject({
        status: 200,
        code: 'INVALID_RESPONSE',
      });
    }

    const proxy = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      capabilities: { control: false },
      fetch: () =>
        Promise.resolve(
          new Response('<html>bad gateway</html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
    });

    await expect(
      Effect.runPromiseExit(proxy.listRuns({ projectKey }, {})).then(valueFromExit),
    ).rejects.toEqual(new ApiError(502, 'INVALID_RESPONSE', 'Attest API request failed (502).'));
    const aborted = new DOMException('Aborted', 'AbortError');

    const cancelled = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      capabilities: { control: false },
      fetch: () => Promise.reject(aborted),
    });

    await expect(
      Effect.runPromiseExit(cancelled.listRuns({ projectKey }, {})).then(valueFromExit),
    ).rejects.toBe(aborted);
  });

  it('pages an offline snapshot and gives contract errors for missing identities', async () => {
    const network = vi.fn(() => Promise.reject(new Error('snapshot touched fetch')));
    vi.stubGlobal('fetch', network);
    const run = runs[0];

    if (run === undefined) throw new Error('Missing fixture run.');

    const client = createApiClient({
      kind: 'snapshot',
      snapshot: {
        generatedAt: '2026-10-18T00:00:00.000Z',
        project,
        run,
        cases: cases.map((record) => ({ record, summary: summarizeCaseRecord(record) })),
        truncated: true,
      },
    });

    expect(client.mode).toEqual({
      kind: 'snapshot',
      generatedAt: '2026-10-18T00:00:00.000Z',
      includedCases: 2,
      truncated: true,
    });
    expect(await Effect.runPromiseExit(client.listProjects()).then(valueFromExit)).toEqual({
      items: [project],
    });
    expect(
      await Effect.runPromiseExit(client.listRuns({ projectKey }, {})).then(valueFromExit),
    ).toEqual({ items: [run] });
    expect(
      await Effect.runPromiseExit(client.listRuns({ projectKey }, { cursor: run.id })).then(
        valueFromExit,
      ),
    ).toEqual({ items: [] });
    expect(
      await Effect.runPromiseExit(client.getRun({ projectKey, runId: run.id })).then(valueFromExit),
    ).toEqual(run);

    const first = await Effect.runPromiseExit(
      client.listCaseSummaries({ projectKey, runId: run.id }, { limit: 1 }),
    ).then(valueFromExit);

    const firstCase = cases[0];

    if (firstCase === undefined) throw new Error('Missing fixture case.');
    expect(first).toEqual({
      items: [summarizeCaseRecord(firstCase)],
      nextCursor: 'row-one',
    });

    const second = await Effect.runPromiseExit(
      client.listCaseSummaries(
        { projectKey, runId: run.id },
        { cursor: first.nextCursor, limit: 1 },
      ),
    ).then(valueFromExit);

    expect(second.items.map((item) => item.caseId)).toEqual(['two']);
    expect(second.nextCursor).toBeUndefined();
    expect(
      await Effect.runPromiseExit(
        client.getCase({ projectKey, runId: run.id, suiteName: 'a/b', caseId: 'two' }),
      ).then(valueFromExit),
    ).toEqual(cases[1]);

    for (const read of [
      () =>
        Effect.runPromiseExit(client.listRuns({ projectKey }, { cursor: 'unknown' })).then(
          valueFromExit,
        ),
      () =>
        Effect.runPromiseExit(
          client.listCaseSummaries({ projectKey, runId: run.id }, { cursor: 'unknown' }),
        ).then(valueFromExit),
    ]) {
      await expect(read()).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_CURSOR',
      });
    }

    await expect(
      Effect.runPromiseExit(client.listRuns({ projectKey }, { limit: 0 })).then(valueFromExit),
    ).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
    await expect(
      Effect.runPromiseExit(client.getRun({ projectKey, runId: 'missing' })).then(valueFromExit),
    ).rejects.toMatchObject({
      status: 404,
      code: 'RUN_NOT_FOUND',
    });
    await expect(
      Effect.runPromiseExit(
        client.getCase({ projectKey, runId: 'missing', suiteName: 'a/b', caseId: 'one' }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
    await expect(
      Effect.runPromiseExit(
        client.getCase({ projectKey, runId: run.id, suiteName: 'a/b', caseId: 'missing' }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ status: 404, code: 'CASE_NOT_FOUND' });
    await expect(
      Effect.runPromiseExit(
        client.getDiff({ projectKey, baseRunId: run.id, candidateRunId: run.id }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    await expect(
      Effect.runPromiseExit(
        client.getDiff({ projectKey, baseRunId: run.id, candidateRunId: 'missing' }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });

    // The embedded project is the only one; every other key fails the same way as the live API.
    for (const read of [
      () => Effect.runPromiseExit(client.listRuns({ projectKey: 'other' }, {})).then(valueFromExit),
      () =>
        Effect.runPromiseExit(client.getRun({ projectKey: 'other', runId: run.id })).then(
          valueFromExit,
        ),
      () =>
        Effect.runPromiseExit(
          client.listCaseSummaries({ projectKey: 'other', runId: run.id }, {}),
        ).then(valueFromExit),
      () =>
        Effect.runPromiseExit(
          client.getCase({ projectKey: 'other', runId: run.id, suiteName: 'a/b', caseId: 'one' }),
        ).then(valueFromExit),
      () =>
        Effect.runPromiseExit(client.listRunSuites({ projectKey: 'other', runId: run.id })).then(
          valueFromExit,
        ),
      () =>
        Effect.runPromiseExit(
          client.getSuiteHistory({ projectKey: 'other', suiteName: 'a/b' }, {}),
        ).then(valueFromExit),
    ]) {
      await expect(read()).rejects.toMatchObject({
        status: 404,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    expect(client.capabilities).toEqual({ control: false });

    for (const control of [
      () => Effect.runPromiseExit(client.listTests({ projectKey })).then(valueFromExit),
      () =>
        Effect.runPromiseExit(client.startRun({ projectKey }, { selection: { all: true } })).then(
          valueFromExit,
        ),
      () =>
        Effect.runPromiseExit(client.cancelRun({ projectKey, runId: run.id })).then(valueFromExit),
    ]) {
      await expect(control()).rejects.toMatchObject({ status: 501, code: 'CONTROL_UNAVAILABLE' });
    }

    expect(network).not.toHaveBeenCalled();
  });

  it('sends control calls as JSON posts and keeps start diagnostics on the error', async () => {
    const control: RunControl = {
      listTests: () => Effect.succeed([{ id: 'smoke', name: 'Smoke', tags: [], caseCount: 1 }]),
      startRun: (_projectKey, request) =>
        'all' in request.selection
          ? Effect.succeed({ runId: '01ARZ3NDEKTSV4RRFFQ69G5FAX' })
          : Effect.fail(
              new StoreError('RUN_START_FAILED', 'The run did not start.', {
                details: { code: 'resource_not_found', message: 'Test nope was not found.' },
              }),
            ),
      cancelRun: () => Effect.succeed({ outcome: 'already_terminal' }),
    };

    const app = new Hono().route(
      '/api',
      createApiApp({ catalog: createSingleProjectCatalog(project, source), control }),
    );

    const methods: string[] = [];

    const client = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      capabilities: { control: true },
      fetch: (input, init) => {
        methods.push(init?.method ?? 'GET');

        return Promise.resolve(app.request(input, init));
      },
    });

    expect(client.capabilities).toEqual({ control: true });
    expect(
      await Effect.runPromiseExit(client.listTests({ projectKey })).then(valueFromExit),
    ).toEqual({
      items: [{ id: 'smoke', name: 'Smoke', tags: [], caseCount: 1 }],
    });
    expect(
      await Effect.runPromiseExit(
        client.startRun({ projectKey }, { selection: { all: true } }),
      ).then(valueFromExit),
    ).toEqual({
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    });
    expect(
      await Effect.runPromiseExit(
        client.cancelRun({ projectKey, runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
      ).then(valueFromExit),
    ).toEqual({
      outcome: 'already_terminal',
    });
    await expect(
      Effect.runPromiseExit(
        client.startRun({ projectKey }, { selection: { testIds: ['nope'] } }),
      ).then(valueFromExit),
    ).rejects.toEqual(
      new ApiError(422, 'RUN_START_FAILED', 'The run did not start.', {
        details: { code: 'resource_not_found', message: 'Test nope was not found.' },
      }),
    );
    expect(methods).toEqual(['GET', 'POST', 'POST', 'POST']);
  });
});

it('retains uncertain dispatch and releases a late response after native interruption without replay', async () => {
  const { RequestObservation } = await import('../request-observation.js');
  let deliver: (response: Response) => void = () => {};

  let admitted = () => {};

  let calls = 0;
  let released = 0;

  const entered = new Promise<void>((resolve) => {
    admitted = resolve;
  });

  const client = createApiClient({
    kind: 'http',
    baseUrl: '/api',
    capabilities: { control: true },
    fetch: () => {
      calls++;
      admitted();

      return new Promise<Response>((resolve) => {
        deliver = resolve;
      });
    },
  });

  const fiber = Effect.runFork(
    client.startRun({ projectKey: 'demo' }, { selection: { all: true } }),
  );

  await entered;
  await Effect.runPromiseExit(Fiber.interrupt(fiber)).then(valueFromExit);
  const outcome = await Effect.runPromiseExit(Fiber.await(fiber)).then(valueFromExit);
  expect(Exit.isFailure(outcome)).toBe(true);

  if (!Exit.isFailure(outcome)) throw new Error('Expected native interruption.');
  expect(Cause.hasInterrupts(outcome.cause)).toBe(true);
  const receipt = Context.getOrUndefined(Cause.annotations(outcome.cause), RequestObservation);
  expect(receipt?.cleanup).toBe('unconfirmed');
  deliver(
    new Response(
      new ReadableStream({
        cancel: () => {
          released++;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(released).toBe(1);
  expect(calls).toBe(1);
  expect(receipt?.cleanup).toBe('confirmed');
});
