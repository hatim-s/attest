import { createContext, use, type ReactNode } from 'react';
import type { ApiClient } from '@attest/api/client';

const ApiClientContext = createContext<ApiClient | null>(null);

/** Supplies the startup-selected source to dashboard queries. */
const ApiClientProvider = ({ client, children }: { client: ApiClient; children: ReactNode }) => (
  <ApiClientContext value={client}>{children}</ApiClientContext>
);

/** Rejects a missing provider before a query can silently choose another source. */
const useApiClient = (): ApiClient => {
  const client = use(ApiClientContext);

  if (client === null) throw new Error('ApiClientProvider is required.');

  return client;
};

export { ApiClientProvider, useApiClient };
