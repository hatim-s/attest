import { createApiClient, type ApiClient } from '@attest/api/client';
import type { DashboardBootstrap } from '@attest/api/contract';
import type { ShellSource } from '../shell/navigation.js';

/** The one host this page reads from: its shell identity plus the client that reads it. */
type DashboardSource = ShellSource & { client: ApiClient };

/**
 * Derives the source from the bootstrap. The id is the HTTP base URL or `snapshot`, so it is
 * stable across reloads and never carries a credential.
 */
const createDashboardSource = (
  bootstrap:
    | Extract<DashboardBootstrap, { kind: 'snapshot' }>
    | (Extract<DashboardBootstrap, { kind: 'http' }> & { fetch?: typeof fetch }),
): DashboardSource => {
  if (bootstrap.kind === 'snapshot') {
    return {
      id: 'snapshot',
      label: 'Report',
      kind: 'report',
      capabilities: { control: false },
      client: createApiClient(bootstrap),
    };
  }

  return {
    id: bootstrap.baseUrl,
    label: bootstrap.host === 'local' ? 'Local' : 'Cloud',
    kind: bootstrap.host,
    capabilities: bootstrap.capabilities,
    client: createApiClient(bootstrap),
  };
};

/** Snapshots never change after the page loads, so only live sources poll or refetch. */
const isLiveSource = (source: DashboardSource) => source.client.mode.kind === 'live';

export { createDashboardSource, isLiveSource, type DashboardSource };
