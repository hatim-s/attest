import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';

import { Dashboard } from './app.js';
import './styles.css';

const rootRoute = createRootRoute({ component: Dashboard });
const router = createRouter({ routeTree: rootRoute });
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1_000 } },
});
const rootElement = document.querySelector('#root');

if (rootElement === null) throw new Error('Dashboard root element was not found.');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

export { queryClient, router };
