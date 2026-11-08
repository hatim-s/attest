import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import { projectRecordSchema, projectRunOverviewSchema } from '@attest/core/records';
import { apiErrorCodeSchema } from './errors.js';

/** One directory row. A project whose store cannot be read carries its error instead of data. */
const projectOverviewEntrySchema = Schema.Union([
  stripStruct({
    status: Schema.Literal('ready'),
    project: projectRecordSchema,
    overview: projectRunOverviewSchema,
  }),
  stripStruct({
    status: Schema.Literal('error'),
    project: projectRecordSchema,
    error: stripStruct({ code: apiErrorCodeSchema, message: Schema.String }),
  }),
]);

const projectOverviewListSchema = stripStruct({
  items: Schema.Array(projectOverviewEntrySchema),
});

type ProjectOverviewEntry = typeof projectOverviewEntrySchema.Type;

type ProjectOverviewList = typeof projectOverviewListSchema.Type;

export {
  projectOverviewEntrySchema,
  projectOverviewListSchema,
  type ProjectOverviewEntry,
  type ProjectOverviewList,
};
