import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import { reportSnapshotSchema } from './snapshot.js';

/** What the serving host can do beyond reads. A snapshot can never start or cancel runs. */
const apiCapabilitiesSchema = stripStruct({ control: Schema.Boolean });

const dashboardBootstrapSchema = Schema.Union([
  stripStruct({
    kind: Schema.Literal('http'),
    baseUrl: Schema.String.check(Schema.isMinLength(1)),
    capabilities: apiCapabilitiesSchema,
  }),
  stripStruct({ kind: Schema.Literal('snapshot'), snapshot: reportSnapshotSchema }),
]);

type ApiCapabilities = typeof apiCapabilitiesSchema.Type;

type DashboardBootstrap = typeof dashboardBootstrapSchema.Type;

export {
  apiCapabilitiesSchema,
  dashboardBootstrapSchema,
  type ApiCapabilities,
  type DashboardBootstrap,
};
