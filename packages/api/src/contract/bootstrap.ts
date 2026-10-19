import { z } from 'zod';
import { reportSnapshotSchema } from './snapshot.js';

/** What the serving host can do beyond reads. A snapshot can never start or cancel runs. */
const apiCapabilitiesSchema = z.object({ control: z.boolean() });

const dashboardBootstrapSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    baseUrl: z.string().min(1),
    capabilities: apiCapabilitiesSchema,
  }),
  z.object({ kind: z.literal('snapshot'), snapshot: reportSnapshotSchema }),
]);

type ApiCapabilities = z.infer<typeof apiCapabilitiesSchema>;

type DashboardBootstrap = z.infer<typeof dashboardBootstrapSchema>;

export {
  apiCapabilitiesSchema,
  dashboardBootstrapSchema,
  type ApiCapabilities,
  type DashboardBootstrap,
};
