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

const demo: ProjectRecord = { key: 'demo', name: 'Demo' };

const other: ProjectRecord = { key: 'other', name: 'Other' };

/** Mounts the dashboard at `path`. Only `demo` has a run, so `other` stops at its runs index. */
const renderAt = (projects: ProjectRecord[], path: string) => {
  const client = createApiClient({
    kind: 'http',
    baseUrl: '/api',
    fetch: (input) => {
      const url = input instanceof Request ? input.url : input.toString();

      return Promise.resolve(
        Response.json(
          url.endsWith('/api/projects')
            ? { items: projects }
            : { items: url.includes('/projects/demo/') ? [run] : [] },
        ),
      );
    },
  });

  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
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

  return { cleanup, container, router };
};

const choose = (select: HTMLSelectElement, value: string) => {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

it('switches projects without the branch and label filters and returns to all projects', async () => {
  const { cleanup, container, router } = renderAt(
    [demo, other],
    '/projects/demo/evals?branch=main&label=env%3Dtest',
  );

  try {
    const select = await vi.waitFor(() => {
      const element = container.querySelector('select');

      if (element?.value !== 'demo') throw new Error('The switcher has not selected Demo yet.');

      return element;
    });

    expect([...select.options].map((option) => option.text)).toEqual([
      'All projects',
      'Demo',
      'Other',
    ]);
    expect(router.state.location.search).toEqual({ branch: 'main', label: 'env=test' });

    choose(select, 'other');
    await vi.waitFor(() => expect(router.state.location.href).toBe('/projects/other/runs'));

    choose(select, '');
    await vi.waitFor(() => expect(router.state.location.href).toBe('/projects'));
  } finally {
    cleanup();
  }
});

it('hides the switcher when the catalog has one project', async () => {
  const { cleanup, container } = renderAt([demo], '/projects/demo/evals');

  try {
    await vi.waitFor(() =>
      expect(container.querySelector('.brand')?.textContent).toContain('Demo'),
    );
    expect(container.querySelector('select')).toBeNull();
  } finally {
    cleanup();
  }
});
