// @vitest-environment happy-dom
import { createApiClient } from '@attest/api/client';
import type { ProjectRecord, RunRecord } from '@attest/core/records';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../api/api-client-context.js';
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

/** Mounts the runs page of a project whose only run is still running. */
const renderRunsPage = (control: boolean) => {
  const client = createApiClient({
    kind: 'http',
    baseUrl: '/api',
    capabilities: { control },
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://host')
        .pathname;

      if (url.endsWith('/api/projects'))
        return Promise.resolve(Response.json({ items: [project] }));

      if (url.endsWith(`/runs/${run.id}`)) return Promise.resolve(Response.json(run));

      return Promise.resolve(Response.json({ items: url.endsWith('/runs') ? [run] : [] }));
    },
  });

  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: ['/projects/demo/runs'] });
  const router = createDashboardRouter(history, { client, queryClient });
  const container = document.createElement('div');
  const root = createRoot(container);

  root.render(
    <ApiClientProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiClientProvider>,
  );

  const cleanup = () => {
    root.unmount();
    queryClient.clear();
    history.destroy();
  };

  return { cleanup, container };
};

const buttonLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((button) => button.textContent);

it.each([
  [true, ['New run', 'Cancel run']],
  [false, []],
])(
  'shows run controls only when the host can control runs (control: %s)',
  async (control, shown) => {
    const { cleanup, container } = renderRunsPage(control);

    try {
      // The header renders once the redirect to the newest run has loaded it.
      await vi.waitFor(() => expect(container.querySelector('.heading-1 .badge')).not.toBeNull());

      const labels = buttonLabels(container);

      expect(labels.filter((label) => label === 'New run' || label === 'Cancel run')).toEqual(
        shown,
      );
    } finally {
      cleanup();
    }
  },
);
