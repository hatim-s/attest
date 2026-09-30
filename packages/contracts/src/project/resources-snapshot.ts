import { z } from 'zod';

import { projectManifestSchema } from './manifest.js';
import { agentResourceSchema } from './resources/agent.js';
import { testCaseSchema, type CaseMetricOverride } from './resources/case.js';
import { datasetResourceSchema } from './resources/dataset.js';
import { metricResourceSchema } from './resources/metric.js';
import { testResourceSchema, type TestResource } from './resources/test.js';
import { reportDuplicates } from '../internal/duplicates.js';

const loadedDatasetSchema = z.strictObject({
  metadata: datasetResourceSchema,
  cases: z.array(testCaseSchema),
});

type LoadedDataset = z.infer<typeof loadedDatasetSchema>;

const resourceTypes = ['agents', 'tests', 'datasets', 'metrics'] as const;

type ResourceType = (typeof resourceTypes)[number];

const resourceLabels = {
  agents: 'agent',
  tests: 'test',
  datasets: 'dataset',
  metrics: 'metric',
} satisfies Record<ResourceType, string>;

const reportManifestParity = (
  manifestIds: readonly string[],
  loadedIds: readonly string[],
  resourceType: ResourceType,
  context: z.RefinementCtx,
): void => {
  const loaded = new Set(loadedIds);
  const manifest = new Set(manifestIds);
  manifestIds.forEach((id, index) => {
    if (!loaded.has(id)) {
      context.addIssue({
        code: 'custom',
        path: ['project', 'resources', resourceType, index, 'id'],
        message: `manifest references an unloaded ${resourceLabels[resourceType]}: ${id}`,
      });
    }
  });
  loadedIds.forEach((id, index) => {
    if (!manifest.has(id)) {
      context.addIssue({
        code: 'custom',
        path: [resourceType, index, 'id'],
        message: `resource is missing from the project manifest: ${id}`,
      });
    }
  });
};

/** Selects the metric override validation shared by dataset rows and resolved test cases. */
type MetricOverrideCheck = {
  overrides: readonly CaseMetricOverride[];
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
  reportDuplicates({
    values: overrides.map(({ metric_id }) => metric_id),
    pathFor: (index) => [...path, 'metric_overrides', index],
    label: 'metric override',
    context,
  });
  overrides.forEach(({ metric_id }, overrideIndex) => {
    const overridePath = [...path, 'metric_overrides', overrideIndex, 'metric_id'];
    if (!metricIds.has(metric_id)) {
      if (reportUnknownMetric) {
        context.addIssue({
          code: 'custom',
          path: overridePath,
          message: `metric is not defined: ${metric_id}`,
        });
      }
      return;
    }
    if (attachment !== undefined && !attachment.metricIds.has(metric_id)) {
      context.addIssue({
        code: 'custom',
        path: overridePath,
        message: `metric is not attached to test ${attachment.testId}: ${metric_id}`,
      });
    }
  });
};

const reportDatasetRows = (
  dataset: LoadedDataset,
  datasetIndex: number,
  metricIds: ReadonlySet<string>,
  context: z.RefinementCtx,
): void => {
  if (dataset.metadata.case_count !== dataset.cases.length) {
    context.addIssue({
      code: 'custom',
      path: ['datasets', datasetIndex, 'metadata', 'case_count'],
      message: `case_count must equal loaded JSONL row count ${dataset.cases.length}`,
    });
  }
  reportDuplicates({
    values: dataset.cases.map(({ id }) => id),
    pathFor: (index) => ['datasets', datasetIndex, 'cases', index],
    label: 'case id',
    context,
  });
  dataset.cases.forEach((testCase, caseIndex) => {
    reportMetricOverrides({
      overrides: testCase.metric_overrides ?? [],
      path: ['datasets', datasetIndex, 'cases', caseIndex],
      context,
      metricIds,
    });
  });
};

type TestReferenceCheck = {
  test: TestResource;
  testIndex: number;
  agentIds: ReadonlySet<string>;
  metricIds: ReadonlySet<string>;
  datasetsById: ReadonlyMap<string, { dataset: LoadedDataset; index: number }>;
  context: z.RefinementCtx;
};

const reportMetricReferences = ({
  test,
  testIndex,
  metricIds,
  context,
}: TestReferenceCheck): void => {
  reportDuplicates({
    values: test.metrics.map(({ metric_id }) => metric_id),
    pathFor: (index) => ['tests', testIndex, 'metrics', index],
    label: 'metric reference',
    context,
  });
  test.metrics.forEach(({ metric_id }, metricIndex) => {
    if (metricIds.has(metric_id)) {
      return;
    }
    context.addIssue({
      code: 'custom',
      path: ['tests', testIndex, 'metrics', metricIndex, 'metric_id'],
      message: `metric is not defined: ${metric_id}`,
    });
  });
};

/** Resolves direct and dataset-attached cases in run order and reports id collisions. */
const reportResolvedCases = (check: TestReferenceCheck): void => {
  const { test, testIndex, metricIds, datasetsById, context } = check;
  const attachment = {
    testId: test.id,
    metricIds: new Set(test.metrics.map(({ metric_id }) => metric_id)),
  };

  reportDuplicates({
    values: test.cases.map(({ id }) => id),
    pathFor: (index) => ['tests', testIndex, 'cases', index, 'id'],
    label: 'resolved case id',
    context,
  });
  test.cases.forEach((testCase, caseIndex) => {
    reportMetricOverrides({
      overrides: testCase.metric_overrides ?? [],
      path: ['tests', testIndex, 'cases', caseIndex],
      context,
      metricIds,
      attachment,
    });
  });

  reportDuplicates({
    values: test.datasets.map(({ dataset_id }) => dataset_id),
    pathFor: (index) => ['tests', testIndex, 'datasets', index],
    label: 'dataset attachment',
    context,
  });
  const resolvedCaseIds = new Set(test.cases.map(({ id }) => id));
  test.datasets.forEach((datasetAttachment, attachmentIndex) => {
    const attachmentPath = ['tests', testIndex, 'datasets', attachmentIndex, 'dataset_id'];
    const attached = datasetsById.get(datasetAttachment.dataset_id);
    if (attached === undefined) {
      context.addIssue({
        code: 'custom',
        path: attachmentPath,
        message: `dataset is not defined: ${datasetAttachment.dataset_id}`,
      });
      return;
    }

    attached.dataset.cases.forEach((testCase, caseIndex) => {
      const tags = new Set(testCase.tags ?? []);
      // Only rows carrying every attachment tag are attached.
      if (datasetAttachment.tags?.some((tag) => !tags.has(tag)) === true) {
        return;
      }
      if (resolvedCaseIds.has(testCase.id)) {
        context.addIssue({
          code: 'custom',
          path: attachmentPath,
          message: `duplicate resolved case id: ${testCase.id}`,
        });
      }
      resolvedCaseIds.add(testCase.id);
      reportMetricOverrides({
        overrides: testCase.metric_overrides ?? [],
        path: ['datasets', attached.index, 'cases', caseIndex],
        context,
        metricIds,
        attachment,
        reportUnknownMetric: false,
      });
    });
  });
};

const reportTestReferences = (check: TestReferenceCheck): void => {
  const { test, testIndex, agentIds, context } = check;
  if (!agentIds.has(test.agent_id)) {
    context.addIssue({
      code: 'custom',
      path: ['tests', testIndex, 'agent_id'],
      message: `agent is not defined: ${test.agent_id}`,
    });
  }
  reportMetricReferences(check);
  reportResolvedCases(check);
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
    for (const resourceType of resourceTypes) {
      reportDuplicates({
        values: resourceIds[resourceType],
        pathFor: (index) => [resourceType, index, 'id'],
        label: 'resource id',
        context,
      });
    }
    for (const resourceType of resourceTypes) {
      reportManifestParity(
        resources.project.resources[resourceType].map(({ id }) => id),
        resourceIds[resourceType],
        resourceType,
        context,
      );
    }

    const metricIds = new Set(resourceIds.metrics);
    resources.datasets.forEach((dataset, datasetIndex) => {
      reportDatasetRows(dataset, datasetIndex, metricIds, context);
    });

    const agentIds = new Set(resourceIds.agents);
    const datasetsById = new Map(
      resources.datasets.map((dataset, index) => [dataset.metadata.id, { dataset, index }]),
    );
    resources.tests.forEach((test, testIndex) => {
      reportTestReferences({ test, testIndex, agentIds, metricIds, datasetsById, context });
    });
  });

type ProjectResources = z.infer<typeof projectResourcesSchema>;

export { projectResourcesSchema, type LoadedDataset, type ProjectResources };
