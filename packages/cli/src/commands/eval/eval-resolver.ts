import {
  evalRunEffectiveCommandSchema,
  evalRunRequestSchema,
  evalRunSnapshotSchema,
  projectResourcesSchema,
  type AgentResource,
  type EvalRunEffectiveCommand,
  type EvalRunRequest,
  type EvalRunSelectedCase,
  type EvalRunSnapshot,
  type MetricResource,
  type TestCase,
  type TestResource,
} from '@attest/contracts';

import { AttestCliError } from '../../errors/index.js';
import { hashCanonicalJson, type JsonValue } from '../../project/canonical-project.js';
import type { LoadedProject } from '../../project/load-project.js';

const DEFAULT_EVAL_CONCURRENCY = 4;
const DEFAULT_EVAL_TIMEOUT_MS = 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

type Immutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T;

type EvalResolverOptions = {
  argv: readonly string[];
  defaultConcurrency?: number;
  defaultTimeoutMs?: number;
  expectedProjectHash?: string;
};

type ResolvedEvalMetric = {
  metric: MetricResource;
  threshold?: number;
};

type ResolvedEvalCaseInput = {
  agent: AgentResource;
  attempt_timeout_ms: number;
  case: TestCase;
  case_id: string;
  concurrency: number;
  configured_index: number;
  execution_id: string;
  metrics: ResolvedEvalMetric[];
  source: EvalRunSelectedCase['source'];
  test: TestResource;
  test_id: string;
};

type ResolvedEvalTestInput = {
  agent: AgentResource;
  concurrency: number;
  test: TestResource;
};

type ResolvedEvalRun = Immutable<{
  cases: ResolvedEvalCaseInput[];
  effectiveCommand: EvalRunEffectiveCommand;
  resources: {
    agents: AgentResource[];
    datasets: LoadedProject['datasets'];
    metrics: MetricResource[];
    tests: TestResource[];
  };
  selectedTests: ResolvedEvalTestInput[];
  snapshot: EvalRunSnapshot;
  snapshotHash: string;
}>;

type ExpandedCase = {
  case: TestCase;
  source: EvalRunSelectedCase['source'];
};

/** Recursively freezes a structured clone so later project mutation cannot alter a run input. */
const immutableClone = <T>(value: T): Immutable<T> => {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    Object.values(candidate).forEach(freeze);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone as Immutable<T>;
};

const duplicateValues = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  values.forEach((value) => (seen.has(value) ? duplicates.add(value) : seen.add(value)));
  return [...duplicates].sort();
};

const formatSchemaPath = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '<root>' : path.map(String).join('.');

/** Revalidates the project read model and its hash coverage. */
const validateLoadedProject = (project: LoadedProject): LoadedProject => {
  const candidate = project as Partial<LoadedProject>;
  const parsed = projectResourcesSchema.safeParse({
    agents: candidate.agents,
    datasets: candidate.datasets,
    metrics: candidate.metrics,
    project: candidate.project,
    tests: candidate.tests,
  });
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map((issue) => ({
      message: issue.message,
      path: formatSchemaPath(issue.path),
    }));
    throw new AttestCliError(
      'project_invalid',
      'Eval resolution requires a complete attest.project project.',
      { details: { diagnostics } },
    );
  }

  if (typeof candidate.projectHash !== 'string' || !SHA256_PATTERN.test(candidate.projectHash)) {
    throw new AttestCliError(
      'project_invalid',
      'The loaded project is missing its canonical project hash.',
    );
  }

  const hashFailures: { id: string; resource_type: string }[] = [];
  const contentHashes = candidate.contentHashes;
  const hasAuthoredHash = (resourceType: 'agents' | 'metrics' | 'tests', id: string): boolean =>
    SHA256_PATTERN.test(contentHashes?.[resourceType]?.[id] ?? '');
  parsed.data.agents.forEach(({ id }) => {
    if (!hasAuthoredHash('agents', id)) hashFailures.push({ id, resource_type: 'agent' });
  });
  parsed.data.tests.forEach(({ id }) => {
    if (!hasAuthoredHash('tests', id)) hashFailures.push({ id, resource_type: 'test' });
  });
  parsed.data.metrics.forEach(({ id }) => {
    if (!hasAuthoredHash('metrics', id)) hashFailures.push({ id, resource_type: 'metric' });
  });
  parsed.data.datasets.forEach(({ metadata: { id } }) => {
    const hashes = contentHashes?.datasets[id];
    if (
      hashes === undefined ||
      !SHA256_PATTERN.test(hashes.data) ||
      !SHA256_PATTERN.test(hashes.metadata)
    ) {
      hashFailures.push({ id, resource_type: 'dataset' });
    }
  });
  if (hashFailures.length > 0) {
    throw new AttestCliError(
      'project_invalid',
      'The loaded project is missing canonical content hashes required for an eval snapshot.',
      { details: { resources: hashFailures } },
    );
  }

  return project;
};

/** Parses only the canonical eval.run request. */
const parseEvalRequest = (request: EvalRunRequest): EvalRunRequest => {
  if (
    request !== null &&
    typeof request === 'object' &&
    !('test_ids' in request) &&
    !('all' in request)
  ) {
    throw new AttestCliError(
      'cli_missing_input',
      'Select one or more exact test ids or pass `--all`.',
    );
  }
  const parsed = evalRunRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'Expected a canonical `attest eval run` request.', {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          message: issue.message,
          path: formatSchemaPath(issue.path),
        })),
      },
    });
  }
  return parsed.data;
};

const requireUniqueSelection = (label: string, values: readonly string[] | undefined): void => {
  const duplicates = duplicateValues(values ?? []);
  if (duplicates.length > 0) {
    throw new AttestCliError('cli_usage', `Duplicate ${label} selection values are not allowed.`, {
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
      throw new AttestCliError(
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
    throw new AttestCliError(
      'project_invalid',
      `Test ${test.id} has duplicate resolved case ids.`,
      {
        details: { case_ids: collisions, test_id: test.id },
      },
    );
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
      throw new AttestCliError(
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
      throw new AttestCliError(
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
  hashCanonicalJson({ case_id: caseId, project_id: projectId, test_id: testId });

const positiveInteger = (value: number | undefined, fallback: number, label: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new AttestCliError('cli_usage', `${label} must be a positive integer.`);
  }
  return resolved;
};

/**
 * Resolves one validated project and canonical eval request into immutable, execution-ready
 * resource/case inputs plus the content-addressed snapshot metadata. It performs no I/O or writes.
 */
const resolveEvalRun = (
  loadedProject: LoadedProject,
  rawRequest: EvalRunRequest,
  options: EvalResolverOptions,
): ResolvedEvalRun => {
  const project = validateLoadedProject(loadedProject);
  const request = parseEvalRequest(rawRequest);
  if (
    options.expectedProjectHash !== undefined &&
    options.expectedProjectHash !== project.projectHash
  ) {
    throw new AttestCliError('project_changed', 'The project changed before eval resolution.', {
      details: {
        current_hash: project.projectHash,
        expected_hash: options.expectedProjectHash,
      },
    });
  }
  if (options.argv.length === 0) {
    throw new AttestCliError(
      'cli_usage',
      'Effective eval command metadata requires non-empty argv.',
    );
  }

  requireUniqueSelection('test id', 'test_ids' in request ? request.test_ids : undefined);
  requireUniqueSelection('case id', request.case_ids);
  requireUniqueSelection('tag', request.tags);

  const testsById = new Map(project.tests.map((test) => [test.id, test]));
  const selectedTestIds =
    'all' in request ? project.project.resources.tests.map(({ id }) => id) : [...request.test_ids];
  if (selectedTestIds.length === 0) {
    throw new AttestCliError('resource_not_found', 'No tests are defined for `--all` selection.', {
      details: { resource_type: 'test' },
    });
  }
  const missingTestIds = selectedTestIds.filter((id) => !testsById.has(id));
  if (missingTestIds.length > 0) {
    throw new AttestCliError('resource_not_found', 'One or more selected test ids do not exist.', {
      details: { missing_ids: missingTestIds, resource_type: 'test' },
    });
  }

  const defaultConcurrency = positiveInteger(
    options.defaultConcurrency,
    DEFAULT_EVAL_CONCURRENCY,
    'Default eval concurrency',
  );
  const defaultTimeoutMs = positiveInteger(
    options.defaultTimeoutMs,
    DEFAULT_EVAL_TIMEOUT_MS,
    'Default eval timeout',
  );
  const projectConcurrency = project.project.defaults?.concurrency ?? defaultConcurrency;
  const concurrency = request.concurrency ?? projectConcurrency;
  const timeoutMs =
    request.timeout_ms ?? project.project.defaults?.eval_timeout_ms ?? defaultTimeoutMs;
  const agentsById = new Map(project.agents.map((agent) => [agent.id, agent]));
  const datasetsById = new Map(project.datasets.map((dataset) => [dataset.metadata.id, dataset]));
  const metricsById = new Map(project.metrics.map((metric) => [metric.id, metric]));
  const caseFilter = request.case_ids === undefined ? undefined : new Set(request.case_ids);
  const tagFilter = request.tags ?? [];
  const foundCaseIds = new Set<string>();
  const selectedTests: ResolvedEvalTestInput[] = [];
  const cases: ResolvedEvalCaseInput[] = [];

  selectedTestIds.forEach((testId) => {
    const test = testsById.get(testId)!;
    const agent = agentsById.get(test.agent_id);
    if (agent === undefined) {
      throw new AttestCliError(
        'project_invalid',
        `Test ${test.id} references missing agent ${test.agent_id}.`,
        { details: { agent_id: test.agent_id, test_id: test.id } },
      );
    }
    const testConcurrency = request.concurrency ?? test.defaults?.concurrency ?? projectConcurrency;
    selectedTests.push({ agent, concurrency: testConcurrency, test });

    expandTestCases(test, datasetsById).forEach((expanded) => {
      if (caseFilter?.has(expanded.case.id) === true) foundCaseIds.add(expanded.case.id);
      if (caseFilter !== undefined && !caseFilter.has(expanded.case.id)) return;
      const tags = new Set(expanded.case.tags ?? []);
      if (tagFilter.some((tag) => !tags.has(tag))) return;
      const metrics = resolveMetrics(test, expanded.case, metricsById);
      cases.push({
        agent,
        attempt_timeout_ms: test.defaults?.timeout_ms ?? agent.timeouts?.attempt_ms ?? 60_000,
        case: expanded.case,
        case_id: expanded.case.id,
        concurrency: testConcurrency,
        configured_index: cases.length,
        execution_id: createExecutionId(project.project.project_id, test.id, expanded.case.id),
        metrics,
        source: expanded.source,
        test,
        test_id: test.id,
      });
    });
  });

  const missingCaseIds = (request.case_ids ?? []).filter((id) => !foundCaseIds.has(id));
  if (missingCaseIds.length > 0) {
    throw new AttestCliError(
      'resource_not_found',
      'One or more selected case ids do not exist in the selected tests.',
      { details: { missing_ids: missingCaseIds, resource_type: 'case' } },
    );
  }
  if (cases.length === 0) {
    throw new AttestCliError('resource_not_found', 'No cases matched the eval selection.', {
      details: { case_ids: request.case_ids ?? [], tags: request.tags ?? [] },
    });
  }

  const selectedAgentIds = new Set(selectedTests.map(({ agent }) => agent.id));
  const selectedDatasetIds = new Set(
    cases.flatMap(({ source }) => (source.kind === 'dataset' ? [source.dataset_id] : [])),
  );
  const selectedMetricIds = new Set(
    cases.flatMap(({ metrics: selectedMetrics }) => selectedMetrics.map(({ metric }) => metric.id)),
  );
  const byId = <T extends { id: string }>(left: T, right: T): number =>
    left.id.localeCompare(right.id);
  const selectedAgents = project.agents.filter(({ id }) => selectedAgentIds.has(id)).sort(byId);
  const selectedTestsResources = selectedTestIds.map((id) => testsById.get(id)!);
  const selectedDatasets = project.datasets
    .filter(({ metadata }) => selectedDatasetIds.has(metadata.id))
    .sort((left, right) => left.metadata.id.localeCompare(right.metadata.id));
  const selectedMetrics = project.metrics.filter(({ id }) => selectedMetricIds.has(id)).sort(byId);
  const snapshot = evalRunSnapshotSchema.parse({
    project_id: project.project.project_id,
    project_hash: project.projectHash,
    resource_hashes: {
      agents: selectedAgents.map(({ id }) => ({
        id,
        content_hash: project.contentHashes.agents[id],
      })),
      tests: [...selectedTestsResources].sort(byId).map(({ id }) => ({
        id,
        content_hash: project.contentHashes.tests[id],
      })),
      datasets: selectedDatasets.map(({ metadata: { id } }) => ({
        id,
        data_content_hash: project.contentHashes.datasets[id]!.data,
        metadata_content_hash: project.contentHashes.datasets[id]!.metadata,
      })),
      metrics: selectedMetrics.map(({ id }) => ({
        id,
        content_hash: project.contentHashes.metrics[id],
      })),
    },
    selected_test_ids: selectedTestIds,
    selected_cases: cases.map(({ configured_index, test_id, case_id, source }) => ({
      configured_index,
      test_id,
      case_id,
      source,
    })),
  });
  const effectiveCommand = evalRunEffectiveCommandSchema.parse({
    command_path: ['eval', 'run'],
    argv: [...options.argv],
    request,
    resolved: {
      concurrency,
      timeout_ms: timeoutMs,
      output: request.output,
      watch: 'watch' in request ? (request.watch ?? false) : false,
      ...(request.baseline_run_id === undefined
        ? {}
        : { baseline_run_id: request.baseline_run_id }),
      ...(request.junit_path === undefined ? {} : { junit_path: request.junit_path }),
    },
  });

  return immutableClone({
    cases,
    effectiveCommand,
    resources: {
      agents: selectedAgents,
      datasets: selectedDatasets,
      metrics: selectedMetrics,
      tests: selectedTestsResources,
    },
    selectedTests,
    snapshot,
    snapshotHash: hashCanonicalJson(snapshot as JsonValue),
  });
};

export {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVAL_TIMEOUT_MS,
  createExecutionId,
  resolveEvalRun,
  type EvalResolverOptions,
  type Immutable,
  type ResolvedEvalCaseInput,
  type ResolvedEvalMetric,
  type ResolvedEvalRun,
  type ResolvedEvalTestInput,
};
