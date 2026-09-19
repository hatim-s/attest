import { z } from 'zod';

import { agentResourceSchema } from './resources/agent.js';
import { testCaseSchema, type CaseMetricOverride } from './resources/case.js';
import { datasetResourceSchema } from './resources/dataset.js';
import { metricResourceSchema } from './resources/metric.js';
import { testResourceSchema } from './resources/test.js';
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

/** Reports repeated ids once per duplicate, appending the trailing id key to each issue path. */
const reportDuplicateIds = (
  ids: ReadonlyArray<string>,
  basePath: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      context.addIssue({
        code: 'custom',
        path: [...basePath, index, 'id'],
        message: `duplicate ${label}: ${id}`,
      });
    }
    seen.add(id);
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
    for (const resourceType of ['agents', 'tests', 'datasets', 'metrics'] as const) {
      reportDuplicateIds(
        project.resources[resourceType].map(({ id }) => id),
        ['resources', resourceType],
        'manifest resource id',
        context,
      );
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

const loadedDatasetSchema = z.strictObject({
  metadata: datasetResourceSchema,
  cases: z.array(testCaseSchema),
});

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

/** Selects the metric override validation shared by dataset rows and resolved test cases. */
type MetricOverrideCheck = {
  overrides: ReadonlyArray<CaseMetricOverride>;
  path: PropertyKey[];
  context: z.RefinementCtx;
  metricIds: ReadonlySet<string>;
  /** When present, every known override must also be attached to the named test. */
  attachment?: { testId: string; metricIds: ReadonlySet<string> };
  /** Dataset-attached rows skip unknown-metric reports; attachment still applies. */
  reportUnknownMetric?: boolean;
};

/** Validates one metric_overrides list for duplicates, known metrics, and test attachment. */
const reportMetricOverrides = (check: MetricOverrideCheck): void => {
  const { overrides, path, context, metricIds, attachment, reportUnknownMetric = true } = check;
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
      return;
    }
    if (attachment !== undefined && !attachment.metricIds.has(metric_id)) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'metric_overrides', overrideIndex, 'metric_id'],
        message: `metric is not attached to test ${attachment.testId}: ${metric_id}`,
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
    const resourceIds = {
      agents: resources.agents.map(({ id }) => id),
      tests: resources.tests.map(({ id }) => id),
      datasets: resources.datasets.map(({ metadata }) => metadata.id),
      metrics: resources.metrics.map(({ id }) => id),
    };
    const resourceTypes = ['agents', 'tests', 'datasets', 'metrics'] as const;
    for (const resourceType of resourceTypes) {
      reportDuplicateIds(resourceIds[resourceType], [resourceType], 'resource id', context);
    }
    for (const resourceType of resourceTypes) {
      reportManifestParity(
        resources.project.resources[resourceType].map(({ id }) => id),
        resourceIds[resourceType],
        resourceType,
        context,
      );
    }

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
        reportMetricOverrides({
          overrides: testCase.metric_overrides ?? [],
          path: ['datasets', datasetIndex, 'cases', caseIndex],
          context,
          metricIds,
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
      const testAttachment = { testId: test.id, metricIds: testMetricIds };

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
        reportMetricOverrides({
          overrides: testCase.metric_overrides ?? [],
          path: ['tests', testIndex, 'cases', caseIndex],
          context,
          metricIds,
          attachment: testAttachment,
        });
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
          reportMetricOverrides({
            overrides: testCase.metric_overrides ?? [],
            path: ['datasets', resources.datasets.indexOf(dataset), 'cases', caseIndex],
            context,
            metricIds,
            attachment: testAttachment,
            reportUnknownMetric: false,
          });
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
