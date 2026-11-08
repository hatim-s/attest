import { createDashboardSource } from '../api/dashboard-source.js';
import type { ProjectRecord, RunRecord } from '@attest/core/records';
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

const project: ProjectRecord = { key: 'demo', name: 'Demo' };

const snapshotClient = () =>
  createDashboardSource({
    kind: 'snapshot',
    snapshot: { project, run, cases: [], generatedAt: run.createdAt, truncated: false },
  });

/** Loads `path` in a memory router and hands the router to `inspect` before cleaning up. */
const loadAt = async (
  client: ReturnType<typeof createDashboardSource>,
  path: string,
  inspect: (router: ReturnType<typeof createDashboardRouter>) => void,
): Promise<void> => {
  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createDashboardRouter(history, { source: client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    await router.load();
    inspect(router);
  } finally {
    queryClient.clear();
    history.destroy();
  }
};

it('encodes suite segments and restores their raw route identity', async () => {
  const client = snapshotClient();
  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: ['/projects/demo'] });
  const router = createDashboardRouter(history, { source: client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    const location = router.buildLocation({
      to: '/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId',
      params: { projectKey: 'demo', runId: run.id, suiteName: 'a/b', caseId: 'one' },
    });

    expect(location.pathname).toBe(`/projects/demo/evals/a%2Fb/runs/${run.id}/cases/one`);
    history.replace(location.href);
    await router.load();

    const match = router.state.matches.find(
      (item) => item.routeId === '/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId',
    );

    expect(match?.params).toMatchObject({
      projectKey: 'demo',
      runId: run.id,
      suiteName: 'a/b',
      caseId: 'one',
    });
  } finally {
    queryClient.clear();
    history.destroy();
  }
});

it('fails a project page with the API error for an unknown project', async () => {
  await loadAt(snapshotClient(), '/projects/other/runs', (router) => {
    const project = router.state.matches.find((item) => item.routeId === '/projects/$projectKey');

    expect(project?.status).toBe('error');
    expect(project?.error).toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      message: 'Project other is not included in this report.',
    });
  });
});
