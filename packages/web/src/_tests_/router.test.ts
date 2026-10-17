import { createApiClient } from '@attest/api/client';
import type { CaseRecord, RunRecord } from '@attest/core/records';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { createDashboardRouter } from '../router.js';

const run: RunRecord = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  schemaId: 'attest.project',
  configHash: 'hash',
  configJson: '{}',
  createdAt: '2026-10-18T00:00:00.000Z',
  status: 'running',
};

const record: CaseRecord = {
  rowId: 'row-one',
  runId: run.id,
  suiteName: 'a/b',
  caseId: 'one',
  inputHash: 'input',
  outcome: 'completed',
  startedAt: run.createdAt,
  durationMs: 1,
  request: { protocol: 'attest.agent-invocation', run_id: run.id, case_id: 'one', input: {} },
  response: { output: 'ok' },
  attempts: [],
  warnings: [],
  diagnostics: {},
  expectedMetrics: [],
  metrics: [],
};

it('parses search once and falls back to cases for unsupported tabs', async () => {
  const client = createApiClient({
    kind: 'snapshot',
    snapshot: { run, cases: [], generatedAt: run.createdAt, truncated: false },
  });

  const queryClient = new QueryClient();

  const history = createMemoryHistory({
    initialEntries: [`/runs/${run.id}?tab=wrong&branch=main&label=env%3Dtest`],
  });

  const router = createDashboardRouter(history, { client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    await router.load();

    expect(router.state.matches.at(-1)?.search).toEqual({
      tab: 'cases',
      branch: 'main',
      label: 'env=test',
    });
    await router.navigate({
      to: '/runs/$runId',
      params: { runId: run.id },
      search: { tab: 'distributions' },
    });
    expect(router.state.matches.at(-1)?.search).toMatchObject({ tab: 'distributions' });
    await router.navigate({
      to: '/runs/$runId',
      params: { runId: run.id },
      search: { tab: 'suites' },
    });
    expect(router.state.matches.at(-1)?.search).toMatchObject({ tab: 'suites' });
  } finally {
    queryClient.clear();
    history.destroy();
  }
});

it('round-trips an encoded suite segment through router params and the API client', async () => {
  const requests: string[] = [];

  const client = createApiClient({
    kind: 'http',
    baseUrl: '/api',
    fetch: (input) => {
      requests.push(input instanceof Request ? input.url : input.toString());

      return Promise.resolve(Response.json(record));
    },
  });

  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: ['/runs'] });
  const router = createDashboardRouter(history, { client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    const location = router.buildLocation({
      to: '/runs/$runId/cases/$suiteName/$caseId',
      params: { runId: run.id, suiteName: 'a/b', caseId: 'one' },
      search: { tab: 'cases' },
    });

    expect(location.pathname).toBe(`/runs/${run.id}/cases/a%2Fb/one`);
    history.replace(location.href);
    await router.load();

    const match = router.state.matches.find(
      (item) => item.routeId === '/runs/$runId/cases/$suiteName/$caseId',
    );

    expect(match?.params).toMatchObject({ runId: run.id, suiteName: 'a/b', caseId: 'one' });

    if (match === undefined) throw new Error('Missing case route match.');
    expect(await client.getCase(match.params)).toEqual(record);
    expect(requests).toEqual([`/api/runs/${run.id}/cases/a%2Fb/one`]);
  } finally {
    queryClient.clear();
    history.destroy();
  }
});

it('replaces the index with the newest run and leaves an empty store at the index', async () => {
  for (const runs of [[run, { ...run, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }], []]) {
    const client = createApiClient({
      kind: 'http',
      baseUrl: '/api',
      fetch: () => Promise.resolve(Response.json({ items: runs })),
    });

    const queryClient = new QueryClient();
    const history = createMemoryHistory({ initialEntries: ['/runs?branch=main'] });
    const router = createDashboardRouter(history, { client, queryClient });
    router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

    try {
      await router.load();

      if (runs.length > 0) {
        expect(router.state.location.pathname).toBe(`/runs/${run.id}`);
        expect(router.state.location.search).toEqual({ branch: 'main', tab: 'cases' });
        expect(history.location.state.__TSR_index).toBe(0);
      } else {
        expect(router.state.location.pathname).toBe('/runs');
        expect(router.state.matches.at(-1)?.routeId).toBe('/runs/');
      }
    } finally {
      queryClient.clear();
      history.destroy();
    }
  }
});
