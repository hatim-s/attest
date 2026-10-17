import { z } from 'zod';
import { reportSnapshotSchema } from './snapshot.js';

const dashboardBootstrapSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http'), baseUrl: z.string().min(1) }),
  z.object({ kind: z.literal('snapshot'), snapshot: reportSnapshotSchema }),
]);

type DashboardBootstrap = z.infer<typeof dashboardBootstrapSchema>;

export { dashboardBootstrapSchema, type DashboardBootstrap };
