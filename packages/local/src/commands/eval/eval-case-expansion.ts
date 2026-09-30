import {
  type EvalRunSelectedCase,
  type MetricResource,
  type TestCase,
  type TestResource,
} from '@attest/contracts';

import { contentHash } from '@attest/core';

import { LocalError } from '../../errors/index.js';
import type { LoadedProject } from '../../project/project-loader/index.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

type ResolvedEvalMetric = {
  metric: MetricResource;
  threshold?: number;
};

type ExpandedCase = {
  case: TestCase;
  source: EvalRunSelectedCase['source'];
};

const duplicateValues = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  values.forEach((value) => (seen.has(value) ? duplicates.add(value) : seen.add(value)));
  return [...duplicates].sort();
};

/** Confirms the loaded project carries every hash an eval snapshot records. */
const assertSnapshotHashes = (project: LoadedProject): void => {
  if (!SHA256_PATTERN.test(project.projectHash)) {
    throw new LocalError(
      'project_invalid',
      'The loaded project is missing its canonical project hash.',
    );
  }
  const hashFailures: { id: string; resource_type: string }[] = [];
  const { contentHashes } = project;
  const hasAuthoredHash = (resourceType: 'agents' | 'metrics' | 'tests', id: string): boolean =>
    SHA256_PATTERN.test(contentHashes[resourceType][id] ?? '');
  project.agents.forEach(({ id }) => {
    if (!hasAuthoredHash('agents', id)) hashFailures.push({ id, resource_type: 'agent' });
  });
  project.tests.forEach(({ id }) => {
    if (!hasAuthoredHash('tests', id)) hashFailures.push({ id, resource_type: 'test' });
  });
  project.metrics.forEach(({ id }) => {
    if (!hasAuthoredHash('metrics', id)) hashFailures.push({ id, resource_type: 'metric' });
  });
  project.datasets.forEach(({ metadata: { id } }) => {
    const hashes = contentHashes.datasets[id];
    if (
      hashes === undefined ||
      !SHA256_PATTERN.test(hashes.data) ||
      !SHA256_PATTERN.test(hashes.metadata)
    ) {
      hashFailures.push({ id, resource_type: 'dataset' });
    }
  });
  if (hashFailures.length > 0) {
    throw new LocalError(
      'project_invalid',
      'The loaded project is missing canonical content hashes required for an eval snapshot.',
      { details: { resources: hashFailures } },
    );
  }
};

const requireUniqueSelection = (label: string, values: readonly string[] | undefined): void => {
  const duplicates = duplicateValues(values ?? []);
  if (duplicates.length > 0) {
    throw new LocalError('cli_usage', `Duplicate ${label} selection values are not allowed.`, {
      details: { duplicates, selection: label },
    });
  }
};

/** Expands direct cases first, then attached dataset rows in authored attachment/row order. */
const expandTestCases = (
  test: TestResource,
  datasetsById: ReadonlyMap<string, LoadedProject['datasets'][number]>,
): ExpandedCase[] => {
  const expanded: ExpandedCase[] = test.cases.map((testCase) => ({
    case: testCase,
    source: { kind: 'direct' },
  }));
  test.datasets.forEach((attachment) => {
    const dataset = datasetsById.get(attachment.dataset_id);
    if (dataset === undefined) {
      throw new LocalError(
        'project_invalid',
        `Test ${test.id} references missing dataset ${attachment.dataset_id}.`,
        { details: { dataset_id: attachment.dataset_id, test_id: test.id } },
      );
    }
    dataset.cases.forEach((testCase) => {
      const tags = new Set(testCase.tags ?? []);
      if (attachment.tags?.some((tag) => !tags.has(tag)) === true) return;
      expanded.push({
        case: testCase,
        source: { kind: 'dataset', dataset_id: attachment.dataset_id },
      });
    });
  });

  const collisions = duplicateValues(expanded.map(({ case: testCase }) => testCase.id));
  if (collisions.length > 0) {
    throw new LocalError('project_invalid', `Test ${test.id} has duplicate resolved case ids.`, {
      details: { case_ids: collisions, test_id: test.id },
    });
  }
  return expanded;
};

/** Resolves attached metric definitions and applies case enable/threshold overrides in test order. */
const resolveMetrics = (
  test: TestResource,
  testCase: TestCase,
  metricsById: ReadonlyMap<string, MetricResource>,
): ResolvedEvalMetric[] => {
  const resolved = new Map(
    test.metrics.map(({ metric_id, threshold }) => [
      metric_id,
      { metric: metricsById.get(metric_id), threshold },
    ]),
  );
  for (const [metricId, value] of resolved) {
    if (value.metric === undefined) {
      throw new LocalError(
        'project_invalid',
        `Test ${test.id} references missing metric ${metricId}.`,
        {
          details: { metric_id: metricId, test_id: test.id },
        },
      );
    }
  }
  testCase.metric_overrides?.forEach((override) => {
    const current = resolved.get(override.metric_id);
    if (current === undefined || current.metric === undefined) {
      throw new LocalError(
        'project_invalid',
        `Case ${testCase.id} references metric ${override.metric_id} that is not attached to test ${test.id}.`,
        { details: { case_id: testCase.id, metric_id: override.metric_id, test_id: test.id } },
      );
    }
    if (override.enabled === false) {
      resolved.delete(override.metric_id);
      return;
    }
    resolved.set(override.metric_id, {
      metric: current.metric,
      threshold: override.threshold ?? current.threshold,
    });
  });
  return [...resolved.values()].map(({ metric, threshold }) => ({
    metric: metric!,
    ...(threshold === undefined ? {} : { threshold }),
  }));
};

/** Generates a move-stable logical execution id from project, test, and authored case identity. */
const createExecutionId = (projectId: string, testId: string, caseId: string): string =>
  contentHash({ case_id: caseId, project_id: projectId, test_id: testId });

export {
  assertSnapshotHashes,
  createExecutionId,
  duplicateValues,
  expandTestCases,
  requireUniqueSelection,
  resolveMetrics,
  type ResolvedEvalMetric,
};
