// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { expect, it, vi } from 'vitest';
import { DashboardSourceProvider } from '../api/api-client-context.js';
import { createDashboardSource, type DashboardSource } from '../api/dashboard-source.js';
import { queryKeys } from '../api/query-keys.js';
import { runSuitesQueryOptions } from '../api/queries/runs.js';
import { createDashboardRouter } from '../router.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

/** Flush React updates triggered by synchronous UI actions. */
const settle = (action: () => void) =>
  act(async () => {
    action();
    await Promise.resolve();
  });

it.each(['/projects/demo/runs', '/projects/demo/evals/one/runs'])(
  'requires a fresh cancellation confirmation after navigating within %s',
  async (path) => {
    const run: RunRecord = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      schemaId: 'attest.project',
      configHash: 'hash',
      configJson: '{}',
      createdAt: '2026-10-18T00:00:00.000Z',
      status: 'running',
    };

    const nextRun = { ...run, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };
    const project = { key: 'demo', name: 'Demo' };

    // Use snapshot reads while exposing the local cancellation control.
    const source = {
      ...createDashboardSource({
        kind: 'snapshot',
        snapshot: { project, run, cases: [], generatedAt: run.createdAt, truncated: false },
      }),
      kind: 'local',
      capabilities: { control: true },
    } satisfies DashboardSource;

    const scope = { sourceId: source.id, projectKey: project.key };
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.runRecord(scope, run.id), run);
    queryClient.setQueryData(queryKeys.runRecord(scope, nextRun.id), nextRun);
    queryClient.setQueryData(
      runSuitesQueryOptions(source, project.key, nextRun.id, false).queryKey,
      { runId: nextRun.id, suites: [] },
    );
    const history = createMemoryHistory({ initialEntries: [`${path}/${run.id}`] });
    const router = createDashboardRouter(history, { source, queryClient });
    router.update({ ...router.options, isServer: false, origin: 'http://localhost' });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await router.load();
      await settle(() => {
        root.render(
          <DashboardSourceProvider source={source}>
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </DashboardSourceProvider>,
        );
      });

      const button = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Cancel run',
      );

      expect(button).toBeDefined();
      await settle(() => button?.click());
      expect(container.textContent).toContain('Confirm cancel');

      await act(() => {
        history.push(`${path}/${nextRun.id}`);

        return router.load();
      });

      expect(container.querySelector('h1 [title]')?.getAttribute('title')).toBe(nextRun.id);
      expect(container.textContent).toContain('Cancel run');
      expect(container.textContent).not.toContain('Confirm cancel');
    } finally {
      await settle(() => root.unmount());
      queryClient.clear();
      history.destroy();
      container.remove();
    }
  },
);
