import { parseWithSchemaSync } from '@attest/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { dashboardBootstrapSchema } from '@attest/api/contract';

import { DashboardSourceProvider } from './api/api-client-context.js';
import { createDashboardSource } from './api/dashboard-source.js';
import { RouterProvider, createHashHistory } from '@tanstack/react-router';
import { createDashboardRouter } from './router.js';

declare global {
  interface Window {
    __ATTEST_BOOTSTRAP__?: unknown;
  }
}

const source = createDashboardSource(
  parseWithSchemaSync(dashboardBootstrapSchema, window.__ATTEST_BOOTSTRAP__),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1_000 } },
});

const router = createDashboardRouter(createHashHistory(), { source, queryClient });

const rootElement = document.querySelector('#root');

if (rootElement === null) throw new Error('Dashboard root element was not found.');

createRoot(rootElement).render(
  <StrictMode>
    <DashboardSourceProvider source={source}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </DashboardSourceProvider>
  </StrictMode>,
);
