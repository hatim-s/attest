import { positiveIntegerSchema } from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

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

const authoredResourceManifestEntrySchema = Schema.Struct({
  id: resourceIdSchema,
  path: relativePathSchema,
  content_hash: sha256Schema,
});

const agentManifestEntrySchema = Schema.Struct({
  ...authoredResourceManifestEntrySchema.fields,
  schema: Schema.Literal(AGENT_RESOURCE_SCHEMA_ID),
});

const testManifestEntrySchema = Schema.Struct({
  ...authoredResourceManifestEntrySchema.fields,
  schema: Schema.Literal(TEST_RESOURCE_SCHEMA_ID),
});

const metricManifestEntrySchema = Schema.Struct({
  ...authoredResourceManifestEntrySchema.fields,
  schema: Schema.Literal(METRIC_RESOURCE_SCHEMA_ID),
});

const datasetManifestEntrySchema = Schema.Struct({
  id: resourceIdSchema,
  schema: Schema.Literal(DATASET_SCHEMA_ID),
  data_path: relativePathSchema,
  data_content_hash: sha256Schema,
  metadata_path: relativePathSchema,
  metadata_content_hash: sha256Schema,
});

const projectDefaultsSchema = Schema.Struct({
  concurrency: Schema.optional(positiveIntegerSchema),
  output_cap_bytes: Schema.optional(positiveIntegerSchema),
  eval_timeout_ms: Schema.optional(durationMillisecondsSchema),
  eval: Schema.optional(evalExecutionConfigSchema),
});

/** Reports a path when a manifest entry does not use the canonical inspectable layout. */
const reportNonCanonicalManifestPath = (
  actual: string,
  expected: string,
  context: Schema.FilterIssue[],
  path: PropertyKey[],
): void => {
  if (actual === expected) {
    return;
  }

  context.push({ path, issue: `must equal canonical path ${expected}` });
};

/** Encodes the generated project index at attest.project.json. */
const projectManifestStructure = Schema.Struct({
  schema: Schema.Literal(PROJECT_SCHEMA_ID),
  project_id: projectIdSchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  defaults: Schema.optional(projectDefaultsSchema),
  resources: Schema.Struct({
    agents: Schema.Array(agentManifestEntrySchema),
    tests: Schema.Array(testManifestEntrySchema),
    datasets: Schema.Array(datasetManifestEntrySchema),
    metrics: Schema.Array(metricManifestEntrySchema),
  }),
});

/** Collects manifest invariants after structural decoding, optionally under a containing path. */
const collectManifestIssues = (
  project: typeof projectManifestStructure.Type,
  prefix: readonly PropertyKey[] = [],
): Schema.FilterIssue[] => {
  const context: Schema.FilterIssue[] = [];

  for (const resourceType of ['agents', 'tests', 'datasets', 'metrics'] as const) {
    reportDuplicates({
      values: project.resources[resourceType].map(({ id }) => id),
      pathFor: (index) => [...prefix, 'resources', resourceType, index, 'id'],
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
        [...prefix, 'resources', resourceType, index, 'path'],
      );
    });
  }

  project.resources.datasets.forEach((entry, index) => {
    reportNonCanonicalManifestPath(entry.data_path, `attest/datasets/${entry.id}.jsonl`, context, [
      ...prefix,
      'resources',
      'datasets',
      index,
      'data_path',
    ]);
    reportNonCanonicalManifestPath(
      entry.metadata_path,
      `attest/datasets/${entry.id}.meta.json`,
      context,
      [...prefix, 'resources', 'datasets', index, 'metadata_path'],
    );
  });

  return context;
};

/** Validates the generated project index and its resource identities and paths. */
const projectManifestSchema = projectManifestStructure
  .check(Schema.makeFilter((project) => collectManifestIssues(project)))
  .annotate({ identifier: 'ProjectManifest' });

type ProjectManifest = typeof projectManifestSchema.Type;

export { projectManifestSchema, collectManifestIssues, type ProjectManifest };
