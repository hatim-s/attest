import { z } from 'zod';

import { evalExecutionConfigSchema } from './eval-execution.js';
import {
  durationMillisecondsSchema,
  projectIdSchema,
  relativePathSchema,
  resourceIdSchema,
  sha256Schema,
} from './shared.js';
import {
  AGENT_RESOURCE_SCHEMA_ID,
  DATASET_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  PROJECT_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
} from '../schema/identifiers.js';
import { reportDuplicates } from '../internal/duplicates.js';

const authoredResourceManifestEntrySchema = z.strictObject({
  id: resourceIdSchema,
  path: relativePathSchema,
  content_hash: sha256Schema,
});

const agentManifestEntrySchema = authoredResourceManifestEntrySchema.extend({
  schema: z.literal(AGENT_RESOURCE_SCHEMA_ID),
});
const testManifestEntrySchema = authoredResourceManifestEntrySchema.extend({
  schema: z.literal(TEST_RESOURCE_SCHEMA_ID),
});
const metricManifestEntrySchema = authoredResourceManifestEntrySchema.extend({
  schema: z.literal(METRIC_RESOURCE_SCHEMA_ID),
});
const datasetManifestEntrySchema = z.strictObject({
  id: resourceIdSchema,
  schema: z.literal(DATASET_SCHEMA_ID),
  data_path: relativePathSchema,
  data_content_hash: sha256Schema,
  metadata_path: relativePathSchema,
  metadata_content_hash: sha256Schema,
});

const projectDefaultsSchema = z.strictObject({
  concurrency: z.number().int().positive().optional(),
  output_cap_bytes: z.number().int().positive().optional(),
  eval_timeout_ms: durationMillisecondsSchema.optional(),
  eval: evalExecutionConfigSchema.optional(),
});

/** Reports a path when a manifest entry does not use the canonical inspectable layout. */
const reportNonCanonicalManifestPath = (
  actual: string,
  expected: string,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void => {
  if (actual === expected) {
    return;
  }

  context.addIssue({ code: 'custom', path, message: `must equal canonical path ${expected}` });
};

/** Encodes the generated project index at attest.project.json. */
const projectManifestSchema = z
  .strictObject({
    schema: z.literal(PROJECT_SCHEMA_ID),
    project_id: projectIdSchema,
    name: z.string().min(1),
    defaults: projectDefaultsSchema.optional(),
    resources: z.strictObject({
      agents: z.array(agentManifestEntrySchema),
      tests: z.array(testManifestEntrySchema),
      datasets: z.array(datasetManifestEntrySchema),
      metrics: z.array(metricManifestEntrySchema),
    }),
  })
  .superRefine((project, context) => {
    for (const resourceType of ['agents', 'tests', 'datasets', 'metrics'] as const) {
      reportDuplicates({
        values: project.resources[resourceType].map(({ id }) => id),
        pathFor: (index) => ['resources', resourceType, index, 'id'],
        label: 'manifest resource id',
        context,
      });
    }

    for (const resourceType of ['agents', 'tests', 'metrics'] as const) {
      project.resources[resourceType].forEach((entry, index) => {
        reportNonCanonicalManifestPath(
          entry.path,
          `attest/${resourceType}/${entry.id}.json`,
          context,
          ['resources', resourceType, index, 'path'],
        );
      });
    }
    project.resources.datasets.forEach((entry, index) => {
      reportNonCanonicalManifestPath(
        entry.data_path,
        `attest/datasets/${entry.id}.jsonl`,
        context,
        ['resources', 'datasets', index, 'data_path'],
      );
      reportNonCanonicalManifestPath(
        entry.metadata_path,
        `attest/datasets/${entry.id}.meta.json`,
        context,
        ['resources', 'datasets', index, 'metadata_path'],
      );
    });
  })
  .meta({ id: 'ProjectManifest' });

type ProjectManifest = z.infer<typeof projectManifestSchema>;

export { projectManifestSchema, type ProjectManifest };
