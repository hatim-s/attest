import { createApiClient } from '@attest/api/client';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

import type { CaseRecord, RunDiff } from '../types.js';

const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const caseRecord: CaseRecord = {
  rowId: 'row-one',
  runId,
  suiteName: 'smoke',
  caseId: 'one',
  inputHash: 'input',
  outcome: 'completed',
  startedAt: '2026-08-07T00:00:00.000Z',
  durationMs: 1,
  request: { protocol: 'attest.agent-invocation', run_id: runId, case_id: 'one', input: {} },
  response: { output: 'working' },
  attempts: [],
  diagnostics: {},
  expectedMetrics: [],
  metrics: [],
  warnings: [],
};

const diff: RunDiff = {
  summary: {
    baseRunId: 'base',
    candidateRunId: runId,
    baseConfigHash: 'base',
    candidateConfigHash: 'candidate',
    counts: { added: 0, removed: 0, fixed: 0, regressed: 0, still_passing: 0, still_failing: 0 },
    flakySuspectCount: 0,
    basePassRate: 1,
    candidatePassRate: 0,
  },
  transitions: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('refreshes final evidence after either run terminates and leaves hidden comparisons idle', async () => {
  let terminal = false;

  const fetch = vi.fn((input: RequestInfo | URL) => {
    const path = input instanceof Request ? input.url : input.toString();

    return Promise.resolve(
      Response.json(
        path.includes('/cases/')
          ? { ...caseRecord, response: { output: terminal ? 'final' : 'working' } }
          : { ...diff, summary: { ...diff.summary, candidatePassRate: terminal ? 1 : 0 } },
      ),
    );
  });

  const api = createApiClient({ kind: 'http', baseUrl: '/api', fetch });
  const { caseQueryOptions, diffQueryOptions } = await import('../queries.js');

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  const selection = { runId, suiteName: 'smoke', caseId: 'one', status: 'running' } as const;

  const comparison = {
    baseRunId: 'base',
    candidateRunId: runId,
    baseStatus: 'running',
    candidateStatus: 'running',
    visible: false,
  } as const;

  const hidden = new QueryObserver(client, diffQueryOptions(api, comparison));
  const unsubscribe = hidden.subscribe(() => {});
  expect(fetch).not.toHaveBeenCalled();

  try {
    expect(await client.fetchQuery(caseQueryOptions(api, selection))).toMatchObject({
      response: { output: 'working' },
    });
    expect(
      (await client.fetchQuery(diffQueryOptions(api, { ...comparison, visible: true }))).summary
        .candidatePassRate,
    ).toBe(0);
    terminal = true;
    expect(
      await client.fetchQuery(caseQueryOptions(api, { ...selection, status: 'completed' })),
    ).toMatchObject({ response: { output: 'final' } });
    expect(
      (
        await client.fetchQuery(
          diffQueryOptions(api, { ...comparison, visible: true, candidateStatus: 'completed' }),
        )
      ).summary.candidatePassRate,
    ).toBe(1);
    expect(
      (
        await client.fetchQuery(
          diffQueryOptions(api, { ...comparison, visible: true, baseStatus: 'completed' }),
        )
      ).summary.candidatePassRate,
    ).toBe(1);
  } finally {
    unsubscribe();
    client.clear();
  }
});
