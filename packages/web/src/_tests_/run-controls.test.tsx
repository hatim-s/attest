// @vitest-environment happy-dom
import { createApiClient } from '@attest/api/client';
import type { ProjectRecord, RunRecord, TestSummary } from '@attest/core/records';
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

const tests: TestSummary[] = [
  { id: 'billing', name: 'Billing', tags: ['fast'], caseCount: 2 },
  { id: 'smoke', name: 'Smoke', tags: [], caseCount: 1 },
  { id: 'slow', name: 'Slow', tags: [], caseCount: 1 },
];

/** What the launcher answers when the CLI never reports `run_started`. */
const startTimeout = () =>
  Response.json(
    {
      error: {
        code: 'RUN_START_FAILED',
        message: 'The attest CLI did not report run_started within 60s.',
        details: {
          code: 'run_failed',
          message: 'The attest CLI did not report run_started within 60s.',
          hint: 'Run attest eval run from a terminal in the project to see where it stops.',
          details: { output: ['loading the project'] },
        },
      },
    },
    { status: 422 },
  );

type Post = { path: string; body: unknown };

/**
 * Mounts the runs page of a project whose only run is still running. Every POST is recorded;
 * `startResponse` answers the start.
 */
const renderRunsPage = ({
  control,
  startResponse = () => Response.json({ runId: run.id }, { status: 201 }),
}: {
  control: boolean;
  startResponse?: () => Response;
}) => {
  const posts: Post[] = [];

  const client = createApiClient({
    kind: 'http',
    baseUrl: '/api',
    capabilities: { control },
    fetch: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://host')
        .pathname;

      if (init?.method === 'POST') {
        const text = await new Response(init.body).text();

        posts.push({ path, body: text === '' ? null : JSON.parse(text) });

        if (path.endsWith('/cancel')) return Response.json({ outcome: 'cancellation_requested' });

        return startResponse();
      }

      if (path.endsWith('/api/projects')) return Response.json({ items: [project] });

      if (path.endsWith('/tests')) return Response.json({ items: tests });

      if (path.endsWith(`/runs/${run.id}`)) return Response.json(run);

      return Response.json({ items: path.endsWith('/runs') ? [run] : [] });
    },
  });

  const queryClient = new QueryClient();
  const history = createMemoryHistory({ initialEntries: ['/projects/demo/runs'] });
  const router = createDashboardRouter(history, { client, queryClient });
  const container = document.createElement('div');
  document.body.append(container);
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
    container.remove();
    queryClient.clear();
    history.destroy();
  };

  return { cleanup, container, posts };
};

const findButton = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === label);

const clickButton = async (container: HTMLElement, label: string) => {
  const button = await vi.waitFor(() => {
    const found = findButton(container, label);

    expect(found).toBeDefined();

    return found;
  });

  button?.click();
};

/** Opens the drawer and unchecks Billing once the test list has loaded. */
const openFormWithoutBilling = async (container: HTMLElement) => {
  await clickButton(container, 'New run');

  const billing = await vi.waitFor(() => {
    const checkbox = container.querySelector<HTMLInputElement>('dialog input[type="checkbox"]');

    expect(checkbox?.checked).toBe(true);

    return checkbox;
  });

  billing?.click();
  await vi.waitFor(() => expect(billing?.checked).toBe(false));
};

it.each([
  [true, ['New run', 'Cancel run']],
  [false, []],
])(
  'shows run controls only when the host can control runs (control: %s)',
  async (control, shown) => {
    const { cleanup, container } = renderRunsPage({ control });

    try {
      // The header renders once the redirect to the newest run has loaded it.
      await vi.waitFor(() => expect(container.querySelector('.heading-1 .badge')).not.toBeNull());

      const labels = [...container.querySelectorAll('button')].map((button) => button.textContent);

      expect(labels.filter((label) => label === 'New run' || label === 'Cancel run')).toEqual(
        shown,
      );
    } finally {
      cleanup();
    }
  },
);

it('starts a run with exactly the checked tests and closes the drawer', async () => {
  const { cleanup, container, posts } = renderRunsPage({ control: true });

  try {
    await openFormWithoutBilling(container);
    await clickButton(container, 'Start run');

    await vi.waitFor(() => expect(container.querySelector('dialog')).toBeNull());
    expect(posts).toEqual([
      { path: '/api/projects/demo/runs', body: { selection: { testIds: ['smoke', 'slow'] } } },
    ]);
  } finally {
    cleanup();
  }
});

it('keeps the form and shows the diagnostics when the start times out', async () => {
  const { cleanup, container, posts } = renderRunsPage({
    control: true,
    startResponse: startTimeout,
  });

  try {
    await openFormWithoutBilling(container);
    await clickButton(container, 'Start run');

    const alert = await vi.waitFor(() => {
      const found = container.querySelector('dialog [role="alert"]');

      expect(found).not.toBeNull();

      return found;
    });

    expect(alert?.textContent).toContain('did not report run_started within 60s');
    expect(alert?.textContent).toContain('loading the project');
    expect(findButton(container, 'Start run')?.disabled).toBe(false);
    expect(
      [...container.querySelectorAll<HTMLInputElement>('dialog input[type="checkbox"]')].map(
        (checkbox) => checkbox.checked,
      ),
    ).toEqual([false, true, true]);
    expect(posts).toHaveLength(1);
  } finally {
    cleanup();
  }
});

it('cancels the run only after the confirmation', async () => {
  const { cleanup, container, posts } = renderRunsPage({ control: true });

  try {
    await clickButton(container, 'Cancel run');
    await clickButton(container, 'Confirm cancel');

    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"].notice')?.textContent).toContain(
        'Cancellation requested',
      ),
    );
    expect(posts).toEqual([{ path: `/api/projects/demo/runs/${run.id}/cancel`, body: null }]);
  } finally {
    cleanup();
  }
});

it('backs out of the cancel confirmation on Escape without cancelling', async () => {
  const { cleanup, container, posts } = renderRunsPage({ control: true });

  try {
    await clickButton(container, 'Cancel run');

    const group = await vi.waitFor(() => {
      const found = container.querySelector('[role="group"][aria-label="Cancel this run?"]');

      expect(found).not.toBeNull();

      return found;
    });

    group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel run'));
    expect(findButton(container, 'Confirm cancel')).toBeUndefined();
    expect(posts).toEqual([]);
  } finally {
    cleanup();
  }
});
