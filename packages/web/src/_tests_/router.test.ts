import { createApiClient } from '@attest/api/client';
import type { RunRecord } from '@attest/core/records';
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

it.each([
  ['env%3Dtest', 'env=test'],
  ['bad', undefined],
])('parses search and drops invalid filters for label=%s', async (label, expectedLabel) => {
  const client = createApiClient({
    kind: 'snapshot',
    snapshot: { run, cases: [], generatedAt: run.createdAt, truncated: false },
  });

  const queryClient = new QueryClient();

  const history = createMemoryHistory({
    initialEntries: [`/runs/${run.id}?tab=wrong&branch=main&label=${label}`],
  });

  const router = createDashboardRouter(history, { client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    await router.load();

    expect(router.state.matches.at(-1)?.search).toEqual({
      tab: 'cases',
      branch: 'main',
      label: expectedLabel,
    });
  } finally {
    queryClient.clear();
    history.destroy();
  }
});

it('encodes suite segments and restores their raw route identity', async () => {
  const client = createApiClient({
    kind: 'snapshot',
    snapshot: { run, cases: [], generatedAt: run.createdAt, truncated: false },
  });

  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: ['/runs'] });
  const router = createDashboardRouter(history, { client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    const location = router.buildLocation({
      to: '/runs/$runId/cases/$suiteName/$caseId',
      params: { runId: run.id, suiteName: 'a/b', caseId: 'one' },
    });

    expect(location.pathname).toBe(`/runs/${run.id}/cases/a%2Fb/one`);
    history.replace(location.href);
    await router.load();

    const match = router.state.matches.find(
      (item) => item.routeId === '/workspace/runs/$runId/cases/$suiteName/$caseId',
    );

    expect(match?.params).toMatchObject({ runId: run.id, suiteName: 'a/b', caseId: 'one' });
  } finally {
    queryClient.clear();
    history.destroy();
  }
});

it('redirects the index to the newest run and leaves an empty store at the index', async () => {
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
      } else {
        expect(router.state.location.pathname).toBe('/runs');
        expect(router.state.matches.at(-1)?.routeId).toBe('/workspace/runs/');
      }
    } finally {
      queryClient.clear();
      history.destroy();
    }
  }
});
