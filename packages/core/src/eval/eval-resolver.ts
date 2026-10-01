import {
  evalRunEffectiveCommandSchema,
  evalRunSnapshotSchema,
  type AgentResource,
  type EvalRunEffectiveCommand,
  type EvalRunRequest,
  type EvalRunSelectedCase,
  type EvalRunSnapshot,
  type MetricResource,
  type TestCase,
  type TestResource,
} from '@attest/contracts';

import { selectCases, CaseSelectionError } from './select-cases.js';
import { contentHash } from '../store/internal/canonical-json.js';

import { EvalResolutionError } from './resolution-project.js';
import type { ResolutionProject } from './resolution-project.js';
import {
  assertSnapshotHashes,
  createExecutionId,
  expandTestCases,
  requireUniqueSelection,
  resolveMetrics,
  type ResolvedEvalMetric,
} from './eval-case-expansion.js';

const DEFAULT_EVAL_CONCURRENCY = 4;
const DEFAULT_EVAL_TIMEOUT_MS = 60_000;

type EvalResolverOptions = {
  argv: readonly string[];
  defaultConcurrency?: number;
  defaultTimeoutMs?: number;
  expectedProjectHash?: string;
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

type ResolvedEvalRun = Readonly<{
  cases: readonly ResolvedEvalCaseInput[];
  effectiveCommand: EvalRunEffectiveCommand;
  resources: {
    agents: AgentResource[];
    datasets: ResolutionProject['datasets'];
    metrics: MetricResource[];
    tests: TestResource[];
  };
  selectedTests: ResolvedEvalTestInput[];
  snapshot: EvalRunSnapshot;
  snapshotHash: string;
}>;

const positiveInteger = (value: number | undefined, fallback: number, label: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new EvalResolutionError('cli_usage', `${label} must be a positive integer.`);
  }
  return resolved;
};

/**
 * Resolves one loaded project and validated eval request into execution-ready
 * resource/case inputs plus the content-addressed snapshot metadata. It performs no I/O or writes.
 */
const resolveEvalRun = (
  project: ResolutionProject,
  request: EvalRunRequest,
  options: EvalResolverOptions,
): ResolvedEvalRun => {
  assertSnapshotHashes(project);
  if (
    options.expectedProjectHash !== undefined &&
    options.expectedProjectHash !== project.projectHash
  ) {
    throw new EvalResolutionError(
      'project_changed',
      'The project changed before eval resolution.',
      {
        details: {
          current_hash: project.projectHash,
          expected_hash: options.expectedProjectHash,
        },
      },
    );
  }
  if (options.argv.length === 0) {
    throw new EvalResolutionError(
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
    throw new EvalResolutionError(
      'resource_not_found',
      'No tests are defined for `--all` selection.',
      {
        details: { resource_type: 'test' },
      },
    );
  }
  const missingTestIds = selectedTestIds.filter((id) => !testsById.has(id));
  if (missingTestIds.length > 0) {
    throw new EvalResolutionError(
      'resource_not_found',
      'One or more selected test ids do not exist.',
      {
        details: { missing_ids: missingTestIds, resource_type: 'test' },
      },
    );
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
  const execution = project.project.defaults?.eval;
  const workerCount = execution?.workers?.count;
  if (
    workerCount !== undefined &&
    request.concurrency !== undefined &&
    request.concurrency !== workerCount
  ) {
    throw new EvalResolutionError(
      'cli_usage',
      '`--concurrency` must equal the configured eval worker count.',
      { details: { concurrency: request.concurrency, worker_count: workerCount } },
    );
  }
  const concurrency = workerCount ?? request.concurrency ?? projectConcurrency;
  const timeoutMs =
    request.timeout_ms ?? project.project.defaults?.eval_timeout_ms ?? defaultTimeoutMs;
  const agentsById = new Map(project.agents.map((agent) => [agent.id, agent]));
  const datasetsById = new Map(project.datasets.map((dataset) => [dataset.metadata.id, dataset]));
  const metricsById = new Map(project.metrics.map((metric) => [metric.id, metric]));
  const selectedTests: ResolvedEvalTestInput[] = [];
  const candidates: ResolvedEvalCaseInput[] = [];

  selectedTestIds.forEach((testId) => {
    const test = testsById.get(testId)!;
    const agent = agentsById.get(test.agent_id);
    if (agent === undefined) {
      throw new EvalResolutionError(
        'project_invalid',
        `Test ${test.id} references missing agent ${test.agent_id}.`,
        { details: { agent_id: test.agent_id, test_id: test.id } },
      );
    }
    if (workerCount !== undefined && agent.transport.kind !== 'native_cli') {
      throw new EvalResolutionError(
        'project_invalid',
        'Eval worker directories require native_cli agents.',
        {
          path: `/agents/${agent.id}/transport/kind`,
          hint: 'Use a native_cli agent, or omit workers to use lifecycle hooks with this transport.',
        },
      );
    }
    if (
      agent.transport.kind === 'native_cli' &&
      agent.transport.sandbox !== undefined &&
      (agent.transport.sandbox.artifacts?.length ?? 0) > 0 &&
      workerCount === undefined &&
      agent.transport.sandbox.artifact_directory === undefined
    ) {
      throw new EvalResolutionError(
        'project_invalid',
        'Sandbox artifacts require eval workers or artifact_directory.',
        {
          path: `/agents/${agent.id}/transport/sandbox/artifact_directory`,
          hint: 'Configure eval workers or a project-relative artifact directory.',
        },
      );
    }
    const testConcurrency =
      workerCount ?? request.concurrency ?? test.defaults?.concurrency ?? projectConcurrency;
    selectedTests.push({ agent, concurrency: testConcurrency, test });

    expandTestCases(test, datasetsById).forEach((expanded) => {
      candidates.push({
        agent,
        attempt_timeout_ms: test.defaults?.timeout_ms ?? agent.timeouts?.attempt_ms ?? timeoutMs,
        case: expanded.case,
        case_id: expanded.case.id,
        concurrency: testConcurrency,
        configured_index: candidates.length,
        execution_id: createExecutionId(project.project.project_id, test.id, expanded.case.id),
        metrics: [],
        source: expanded.source,
        test,
        test_id: test.id,
      });
    });
  });

  let selection: ReturnType<typeof selectCases<ResolvedEvalCaseInput>>;
  try {
    selection = selectCases(candidates, request);
  } catch (error) {
    if (!(error instanceof CaseSelectionError)) throw error;
    throw new EvalResolutionError(
      error.code === 'invalid_selection' ? 'cli_usage' : 'resource_not_found',
      error.message,
      { details: error.details },
    );
  }
  const cases = selection.cases.map((candidate, configured_index) => ({
    ...candidate,
    configured_index,
    metrics: resolveMetrics(candidate.test, candidate.case, metricsById),
  }));

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
    selection: selection.summary,
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
      ...(execution === undefined ? {} : { execution }),
      ...(request.baseline_run_id === undefined
        ? {}
        : { baseline_run_id: request.baseline_run_id }),
      ...(request.junit_path === undefined ? {} : { junit_path: request.junit_path }),
    },
  });

  return {
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
    snapshotHash: contentHash(snapshot),
  };
};

export {
  resolveEvalRun,
  type ResolvedEvalCaseInput,
  type ResolvedEvalRun,
  type EvalResolverOptions,
};
