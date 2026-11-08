import { createContext, use, type ReactNode } from 'react';
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

export { DashboardSourceProvider, useDashboardSource };
