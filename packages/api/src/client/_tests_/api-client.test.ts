import { diffRuns, StoreError, summarizeCaseRecord, type RunSource } from '@attest/core';
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
  listRuns: () => Promise.resolve({ items: runs }),
  getRun: (runId) => {
    const run = runs.find((run) => run.id === runId);

    if (run === undefined) throw new StoreError('RUN_NOT_FOUND', `Run ${runId} missing.`);

    return Promise.resolve(run);
  },
  listCaseSummaries: () => Promise.resolve({ items: cases.map(summarizeCaseRecord) }),
  getCase: (runId, suiteName, caseId) => {
    const found = cases.find(
      (record) =>
        record.runId === runId && record.suiteName === suiteName && record.caseId === caseId,
    );

    if (found === undefined) throw new StoreError('CASE_NOT_FOUND', 'Case missing.');

    return Promise.resolve(found);
  },
  getRunWithCases: async (runId) => ({
    run: await source.getRun(runId),
    cases: cases.filter((record) => record.runId === runId),
  }),
};

const reads = (client: ApiClient) => [
  () => client.listRuns({}),
  () => client.getRun({ runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
  () => client.listCaseSummaries({ runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, {}),
  () => client.getCase({ runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', suiteName: 'a/b', caseId: 'one' }),
  () =>
    client.getDiff({
      baseRunId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      candidateRunId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }),
];

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient', () => {
  it('round-trips every HTTP route including suite slashes, query and abort signal', async () => {
    const app = new Hono().route('/api', createApiApp({ source }));
    const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];

    const client = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      fetch: (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          signal: init?.signal,
        });

        return Promise.resolve(app.request(input, init));
      },
    });

    const expected = [
      { items: runs },
      runs[0],
      { items: cases.map(summarizeCaseRecord) },
      cases[0],
      await diffRuns(source, '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    ];

    for (const [index, read] of reads(client).entries())
      expect(await read()).toEqual(expected[index]);
    const controller = new AbortController();
    await client.listRuns({ cursor: 'anchor', limit: 2 }, { signal: controller.signal });
    expect(requests.at(-1)).toEqual({
      url: '/api/runs?cursor=anchor&limit=2',
      signal: controller.signal,
    });
    expect(requests.map(({ url }) => url)).toContain(
      '/api/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV/cases/a%2Fb/one',
    );
    await expect(client.getRun({ runId: 'missing' })).rejects.toMatchObject({
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
      fetch: () => Promise.resolve(Response.json({})),
    });

    for (const read of reads(client)) {
      await expect(read()).rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE' });
    }

    const proxy = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      fetch: () =>
        Promise.resolve(
          new Response('<html>bad gateway</html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
    });

    await expect(proxy.listRuns({})).rejects.toEqual(
      new ApiError(502, 'INVALID_RESPONSE', 'Attest API request failed (502).'),
    );
    const aborted = new DOMException('Aborted', 'AbortError');

    const cancelled = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      fetch: () => Promise.reject(aborted),
    });

    await expect(cancelled.listRuns({})).rejects.toBe(aborted);
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
    expect(await client.listRuns({})).toEqual({ items: [run] });
    expect(await client.listRuns({ cursor: run.id })).toEqual({ items: [] });
    expect(await client.getRun({ runId: run.id })).toEqual(run);
    const first = await client.listCaseSummaries({ runId: run.id }, { limit: 1 });
    const firstCase = cases[0];

    if (firstCase === undefined) throw new Error('Missing fixture case.');
    expect(first).toEqual({
      items: [summarizeCaseRecord(firstCase)],
      nextCursor: 'row-one',
    });

    const second = await client.listCaseSummaries(
      { runId: run.id },
      { cursor: first.nextCursor, limit: 1 },
    );

    expect(second.items.map((item) => item.caseId)).toEqual(['two']);
    expect(second.nextCursor).toBeUndefined();
    expect(await client.getCase({ runId: run.id, suiteName: 'a/b', caseId: 'two' })).toEqual(
      cases[1],
    );

    for (const read of [
      () => client.listRuns({ cursor: 'unknown' }),
      () => client.listCaseSummaries({ runId: run.id }, { cursor: 'unknown' }),
    ]) {
      await expect(read()).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
    }

    await expect(client.listRuns({ limit: 0 })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
    await expect(client.getRun({ runId: 'missing' })).rejects.toMatchObject({
      status: 404,
      code: 'RUN_NOT_FOUND',
    });
    await expect(
      client.getCase({ runId: 'missing', suiteName: 'a/b', caseId: 'one' }),
    ).rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
    await expect(
      client.getCase({ runId: run.id, suiteName: 'a/b', caseId: 'missing' }),
    ).rejects.toMatchObject({ status: 404, code: 'CASE_NOT_FOUND' });
    await expect(
      client.getDiff({ baseRunId: run.id, candidateRunId: run.id }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    await expect(
      client.getDiff({ baseRunId: run.id, candidateRunId: 'missing' }),
    ).rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
    expect(network).not.toHaveBeenCalled();
  });
});
