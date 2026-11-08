import { createContext, use, type ReactNode } from 'react';
import type { ApiClient } from '@attest/api/client';
import type { DashboardSource } from './dashboard-source.js';

const DashboardSourceContext = createContext<DashboardSource | null>(null);

/** Supplies the startup-selected source to dashboard queries. */
const DashboardSourceProvider = ({
  source,
  children,
}: {
  source: DashboardSource;
  children: ReactNode;
}) => <DashboardSourceContext value={source}>{children}</DashboardSourceContext>;

/** Rejects a missing provider before a query can silently choose another source. */
const useDashboardSource = (): DashboardSource => {
  const source = use(DashboardSourceContext);

  if (source === null) throw new Error('DashboardSourceProvider is required.');

  return source;
};

/** The source's client, for the run and case pages that still key queries without a source. */
const useApiClient = (): ApiClient => useDashboardSource().client;

export { DashboardSourceProvider, useDashboardSource, useApiClient };
