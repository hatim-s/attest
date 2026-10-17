import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { createApiClient } from '@attest/api/client';
import { dashboardBootstrapSchema } from '@attest/api/contract';

import { ApiClientProvider } from './api/api-client-context.js';
import { Dashboard } from './app.js';
import './styles.css';

declare global {
  interface Window {
    __ATTEST_BOOTSTRAP__?: unknown;
  }
}

const client = createApiClient(dashboardBootstrapSchema.parse(window.__ATTEST_BOOTSTRAP__));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1_000 } },
});

const rootElement = document.querySelector('#root');

if (rootElement === null) throw new Error('Dashboard root element was not found.');

createRoot(rootElement).render(
  <StrictMode>
    <ApiClientProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    </ApiClientProvider>
  </StrictMode>,
);
