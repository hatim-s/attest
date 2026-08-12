import { z } from 'zod';

import { agentResourceSchema } from './resources/agent.js';
import { testCaseSchema } from './resources/case.js';
import { datasetResourceSchema } from './resources/dataset.js';
import { metricResourceSchema } from './resources/metric.js';
import { testResourceSchema } from './resources/test.js';
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

/** Reports duplicate ids inside one generated manifest resource list. */
const reportDuplicateManifestIds = (
  entries: ReadonlyArray<{ id: string }>,
  resourceType: string,
  context: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      context.addIssue({
        code: 'custom',
        path: ['resources', resourceType, index, 'id'],
        message: `duplicate manifest resource id: ${entry.id}`,
      });
    }
    seen.add(entry.id);
  });
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
    reportDuplicateManifestIds(project.resources.agents, 'agents', context);
    reportDuplicateManifestIds(project.resources.tests, 'tests', context);
    reportDuplicateManifestIds(project.resources.datasets, 'datasets', context);
    reportDuplicateManifestIds(project.resources.metrics, 'metrics', context);

    project.resources.agents.forEach((entry, index) =>
      reportNonCanonicalManifestPath(entry.path, `attest/agents/${entry.id}.json`, context, [
        'resources',
        'agents',
        index,
        'path',
      ]),
    );
    project.resources.tests.forEach((entry, index) =>
      reportNonCanonicalManifestPath(entry.path, `attest/tests/${entry.id}.json`, context, [
        'resources',
        'tests',
        index,
        'path',
      ]),
    );
    project.resources.metrics.forEach((entry, index) =>
      reportNonCanonicalManifestPath(entry.path, `attest/metrics/${entry.id}.json`, context, [
        'resources',
        'metrics',
        index,
        'path',
      ]),
    );
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

const loadedDatasetSchema = z.strictObject({
  metadata: datasetResourceSchema,
  cases: z.array(testCaseSchema),
});

const reportDuplicateIds = (
  values: ReadonlyArray<{ id: string }>,
  path: string,
  context: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      context.addIssue({
        code: 'custom',
        path: [path, index, 'id'],
        message: `duplicate resource id: ${value.id}`,
      });
    }
    seen.add(value.id);
  });
};

const reportDuplicateFieldValues = (
  values: ReadonlyArray<string>,
  path: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: `duplicate ${label}: ${value}`,
      });
    }
    seen.add(value);
  });
};

const reportManifestParity = (
  manifestIds: ReadonlyArray<string>,
  loadedIds: ReadonlyArray<string>,
  path: string,
  context: z.RefinementCtx,
): void => {
  const loaded = new Set(loadedIds);
  const manifest = new Set(manifestIds);
  manifestIds.forEach((id, index) => {
    if (!loaded.has(id)) {
      context.addIssue({
        code: 'custom',
        path: ['project', 'resources', path, index, 'id'],
        message: `manifest references an unloaded ${path.slice(0, -1)}: ${id}`,
      });
    }
  });
  loadedIds.forEach((id, index) => {
    if (!manifest.has(id)) {
      context.addIssue({
        code: 'custom',
        path: [path, index, 'id'],
        message: `resource is missing from the project manifest: ${id}`,
      });
    }
  });
};

/**
 * Encodes the loader-facing project snapshot and aggregates every reference invariant.
 * This is a runtime validation shape rather than another authored file format.
 */
const projectResourcesSchema = z
  .strictObject({
    project: projectManifestSchema,
    agents: z.array(agentResourceSchema),
    tests: z.array(testResourceSchema),
    datasets: z.array(loadedDatasetSchema),
    metrics: z.array(metricResourceSchema),
  })
  .superRefine((resources, context) => {
    reportDuplicateIds(resources.agents, 'agents', context);
    reportDuplicateIds(resources.tests, 'tests', context);
    reportDuplicateIds(
      resources.datasets.map(({ metadata }) => metadata),
      'datasets',
      context,
    );
    reportDuplicateIds(resources.metrics, 'metrics', context);

    const datasetIds = resources.datasets.map(({ metadata }) => metadata.id);
    reportManifestParity(
      resources.project.resources.agents.map(({ id }) => id),
      resources.agents.map(({ id }) => id),
      'agents',
      context,
    );
    reportManifestParity(
      resources.project.resources.tests.map(({ id }) => id),
      resources.tests.map(({ id }) => id),
      'tests',
      context,
    );
    reportManifestParity(
      resources.project.resources.datasets.map(({ id }) => id),
      datasetIds,
      'datasets',
      context,
    );
    reportManifestParity(
      resources.project.resources.metrics.map(({ id }) => id),
      resources.metrics.map(({ id }) => id),
      'metrics',
      context,
    );

    const agentIds = new Set(resources.agents.map(({ id }) => id));
    const metricIds = new Set(resources.metrics.map(({ id }) => id));
    const datasets = new Map(resources.datasets.map((dataset) => [dataset.metadata.id, dataset]));

    resources.datasets.forEach((dataset, datasetIndex) => {
      if (dataset.metadata.case_count !== dataset.cases.length) {
        context.addIssue({
          code: 'custom',
          path: ['datasets', datasetIndex, 'metadata', 'case_count'],
          message: `case_count must equal loaded JSONL row count ${dataset.cases.length}`,
        });
      }
      reportDuplicateFieldValues(
        dataset.cases.map(({ id }) => id),
        ['datasets', datasetIndex, 'cases'],
        'case id',
        context,
      );
      dataset.cases.forEach((testCase, caseIndex) => {
        const overrides = testCase.metric_overrides ?? [];
        reportDuplicateFieldValues(
          overrides.map(({ metric_id }) => metric_id),
          ['datasets', datasetIndex, 'cases', caseIndex, 'metric_overrides'],
          'metric override',
          context,
        );
        overrides.forEach(({ metric_id }, overrideIndex) => {
          if (!metricIds.has(metric_id)) {
            context.addIssue({
              code: 'custom',
              path: [
                'datasets',
                datasetIndex,
                'cases',
                caseIndex,
                'metric_overrides',
                overrideIndex,
                'metric_id',
              ],
              message: `metric is not defined: ${metric_id}`,
            });
          }
        });
      });
    });

    resources.tests.forEach((test, testIndex) => {
      if (!agentIds.has(test.agent_id)) {
        context.addIssue({
          code: 'custom',
          path: ['tests', testIndex, 'agent_id'],
          message: `agent is not defined: ${test.agent_id}`,
        });
      }

      reportDuplicateFieldValues(
        test.metrics.map(({ metric_id }) => metric_id),
        ['tests', testIndex, 'metrics'],
        'metric reference',
        context,
      );
      test.metrics.forEach(({ metric_id }, metricIndex) => {
        if (!metricIds.has(metric_id)) {
          context.addIssue({
            code: 'custom',
            path: ['tests', testIndex, 'metrics', metricIndex, 'metric_id'],
            message: `metric is not defined: ${metric_id}`,
          });
        }
      });

      const testMetricIds = new Set(test.metrics.map(({ metric_id }) => metric_id));
      const reportCaseMetricOverrides = (
        testCase: z.infer<typeof testCaseSchema>,
        path: PropertyKey[],
        reportUnknownMetric = true,
      ): void => {
        const overrides = testCase.metric_overrides ?? [];
        reportDuplicateFieldValues(
          overrides.map(({ metric_id }) => metric_id),
          [...path, 'metric_overrides'],
          'metric override',
          context,
        );
        overrides.forEach(({ metric_id }, overrideIndex) => {
          if (!metricIds.has(metric_id)) {
            if (reportUnknownMetric) {
              context.addIssue({
                code: 'custom',
                path: [...path, 'metric_overrides', overrideIndex, 'metric_id'],
                message: `metric is not defined: ${metric_id}`,
              });
            }
          } else if (!testMetricIds.has(metric_id)) {
            context.addIssue({
              code: 'custom',
              path: [...path, 'metric_overrides', overrideIndex, 'metric_id'],
              message: `metric is not attached to test ${test.id}: ${metric_id}`,
            });
          }
        });
      };

      const resolvedCaseIds = new Set<string>();
      test.cases.forEach((testCase, caseIndex) => {
        if (resolvedCaseIds.has(testCase.id)) {
          context.addIssue({
            code: 'custom',
            path: ['tests', testIndex, 'cases', caseIndex, 'id'],
            message: `duplicate resolved case id: ${testCase.id}`,
          });
        }
        resolvedCaseIds.add(testCase.id);
        reportCaseMetricOverrides(testCase, ['tests', testIndex, 'cases', caseIndex]);
      });

      reportDuplicateFieldValues(
        test.datasets.map(({ dataset_id }) => dataset_id),
        ['tests', testIndex, 'datasets'],
        'dataset attachment',
        context,
      );
      test.datasets.forEach((attachment, attachmentIndex) => {
        const dataset = datasets.get(attachment.dataset_id);
        if (dataset === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['tests', testIndex, 'datasets', attachmentIndex, 'dataset_id'],
            message: `dataset is not defined: ${attachment.dataset_id}`,
          });
          return;
        }

        dataset.cases.forEach((testCase, caseIndex) => {
          const tags = new Set(testCase.tags ?? []);
          // Reproduce the ratified all-tags attachment filter before detecting resolved collisions.
          if (attachment.tags?.some((tag) => !tags.has(tag)) === true) {
            return;
          }
          if (resolvedCaseIds.has(testCase.id)) {
            context.addIssue({
              code: 'custom',
              path: ['tests', testIndex, 'datasets', attachmentIndex, 'dataset_id'],
              message: `duplicate resolved case id: ${testCase.id}`,
            });
          }
          resolvedCaseIds.add(testCase.id);
          reportCaseMetricOverrides(
            testCase,
            ['datasets', resources.datasets.indexOf(dataset), 'cases', caseIndex],
            false,
          );
        });
      });
    });
  });

type LoadedDataset = z.infer<typeof loadedDatasetSchema>;
type ProjectManifest = z.infer<typeof projectManifestSchema>;
type ProjectResources = z.infer<typeof projectResourcesSchema>;

export {
  datasetManifestEntrySchema,
  loadedDatasetSchema,
  projectManifestSchema,
  projectResourcesSchema,
  type LoadedDataset,
  type ProjectManifest,
  type ProjectResources,
};
