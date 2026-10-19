import { createApiClient } from '@attest/api/client';
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
  createApiClient({
    kind: 'snapshot',
    snapshot: { project, run, cases: [], generatedAt: run.createdAt, truncated: false },
  });

/** Answers `/api/projects` with `projects` and every runs page with `runs`. */
const httpClient = (projects: ProjectRecord[], runs: RunRecord[]) =>
  createApiClient({
    kind: 'http',
    baseUrl: '/api',
    fetch: (input) => {
      const path = input instanceof Request ? input.url : input.toString();

      return Promise.resolve(
        Response.json(path.endsWith('/api/projects') ? { items: projects } : { items: runs }),
      );
    },
  });

/** Loads `path` in a memory router and hands the router to `inspect` before cleaning up. */
const loadAt = async (
  client: ReturnType<typeof createApiClient>,
  path: string,
  inspect: (router: ReturnType<typeof createDashboardRouter>) => void,
): Promise<void> => {
  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createDashboardRouter(history, { client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    await router.load();
    inspect(router);
  } finally {
    queryClient.clear();
    history.destroy();
  }
};

it.each([
  ['env%3Dtest', 'env=test', 'wrong', 'cases'],
  ['env%3Dtest', 'env=test', 'suites', 'suites'],
  ['bad', undefined, 'wrong', 'cases'],
])(
  'parses search and drops invalid filters for label=%s',
  async (label, expectedLabel, tab, expectedTab) => {
    await loadAt(
      snapshotClient(),
      `/projects/demo/runs/${run.id}?tab=${tab}&branch=main&label=${label}`,
      (router) => {
        expect(router.state.matches.at(-1)?.search).toEqual({
          tab: expectedTab,
          branch: 'main',
          label: expectedLabel,
        });
      },
    );
  },
);

it('encodes suite segments and restores their raw route identity', async () => {
  const client = snapshotClient();
  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: ['/projects/demo/runs'] });
  const router = createDashboardRouter(history, { client, queryClient });
  router.update({ ...router.options, isServer: false, origin: 'http://localhost' });

  try {
    const location = router.buildLocation({
      to: '/projects/$projectKey/runs/$runId/cases/$suiteName/$caseId',
      params: { projectKey: 'demo', runId: run.id, suiteName: 'a/b', caseId: 'one' },
    });

    expect(location.pathname).toBe(`/projects/demo/runs/${run.id}/cases/a%2Fb/one`);
    history.replace(location.href);
    await router.load();

    const match = router.state.matches.find(
      (item) => item.routeId === '/projects/$projectKey/runs/$runId/cases/$suiteName/$caseId',
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

it('opens the only project from / and lists projects otherwise', async () => {
  const other: ProjectRecord = { key: 'other', name: 'Other' };

  await loadAt(httpClient([project], [run]), '/', (router) => {
    expect(router.state.location.pathname).toBe(`/projects/demo/runs/${run.id}`);
  });

  for (const projects of [[project, other], []]) {
    await loadAt(httpClient(projects, []), '/', (router) => {
      expect(router.state.location.pathname).toBe('/projects');
      expect(router.state.matches.at(-1)?.routeId).toBe('/projects');
    });
  }
});

it('redirects a project to its newest run and leaves an empty project at its runs index', async () => {
  for (const runs of [[run, { ...run, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }], []]) {
    await loadAt(httpClient([project], runs), '/projects/demo/runs?branch=main', (router) => {
      if (runs.length > 0) {
        expect(router.state.location.pathname).toBe(`/projects/demo/runs/${run.id}`);
        expect(router.state.location.search).toEqual({ branch: 'main', tab: 'cases' });
      } else {
        expect(router.state.location.pathname).toBe('/projects/demo/runs');
        expect(router.state.matches.at(-1)?.routeId).toBe('/projects/$projectKey/runs/');
      }
    });
  }
});

it('fails the workspace with the API error for an unknown project', async () => {
  await loadAt(snapshotClient(), '/projects/other/runs', (router) => {
    const workspace = router.state.matches.find((item) => item.routeId === '/projects/$projectKey');

    expect(workspace?.status).toBe('error');
    expect(workspace?.error).toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      message: 'Project other is not included in this report.',
    });
  });
});
