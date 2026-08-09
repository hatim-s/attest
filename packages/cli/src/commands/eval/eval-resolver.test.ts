import {
  AGENT_RESOURCE_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  DATASET_SCHEMA_VERSION,
  METRIC_RESOURCE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
  type AgentResource,
  type EvalRunRequest,
  type MetricResource,
  type ProjectManifest,
  type TestCase,
  type TestResource,
} from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { AttestCliError } from '../../errors.js';
import {
  hashCanonicalJson,
  hashCanonicalJsonLines,
  type JsonValue,
} from '../../project/canonical-project.js';
import type { LoadedProject } from '../../project/load-project.js';
import { resolveEvalRun } from './eval-resolver.js';

const PROJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const BASELINE_RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';

const canonicalHash = (value: unknown): string => hashCanonicalJson(value as JsonValue);

const createAgent = (id: string): AgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_VERSION,
  id,
  name: `${id} agent`,
  transport: { kind: 'native_cli', lifecycle: 'per_case', argv: ['node', 'agent.mjs'] },
  timeouts: { attempt_ms: 45_000 },
});

const createMetric = (id: string): MetricResource => ({
  schema: METRIC_RESOURCE_SCHEMA_VERSION,
  id,
  name: `${id} metric`,
  definition: { kind: 'judge', model: 'local/test', rubric: 'Be correct.', threshold: 0.5 },
});

const directCases = (): TestCase[] => [
  {
    id: 'direct-smoke',
    input: { prompt: 'direct smoke' },
    tags: ['smoke', 'api'],
    metric_overrides: [{ metric_id: 'quality', threshold: 0.9 }],
  },
  { id: 'direct-only', input: { prompt: 'direct only' }, tags: ['smoke'] },
];

const datasetCases = (): TestCase[] => [
  { id: 'dataset-smoke', input: { prompt: 'dataset smoke' }, tags: ['smoke', 'api'] },
  { id: 'dataset-api', input: { prompt: 'dataset api' }, tags: ['api'] },
];

const createTest = (id: string, agentId: string, cases: TestCase[]): TestResource => ({
  schema: TEST_RESOURCE_SCHEMA_VERSION,
  id,
  name: `${id} test`,
  agent_id: agentId,
  cases,
  datasets: id === 'alpha' ? [{ dataset_id: 'shared', tags: ['api'] }] : [],
  metrics: [{ metric_id: 'quality', threshold: 0.7 }],
  defaults: { concurrency: id === 'alpha' ? 2 : 3, timeout_ms: 30_000 },
});

/** Recomputes every manifest/read-model hash after a hostile fixture mutation. */
const refreshHashes = (project: LoadedProject): LoadedProject => {
  const agentHashes = Object.fromEntries(
    project.agents.map((agent) => [agent.id, canonicalHash(agent)]),
  );
  const testHashes = Object.fromEntries(
    project.tests.map((test) => [test.id, canonicalHash(test)]),
  );
  const metricHashes = Object.fromEntries(
    project.metrics.map((metric) => [metric.id, canonicalHash(metric)]),
  );
  const datasetHashes = Object.fromEntries(
    project.datasets.map((dataset) => [
      dataset.metadata.id,
      {
        data: hashCanonicalJsonLines(dataset.cases as JsonValue[]),
        metadata: canonicalHash(dataset.metadata),
      },
    ]),
  );
  project.project.resources.agents.forEach((entry) => {
    entry.content_hash = agentHashes[entry.id]!;
  });
  project.project.resources.tests.forEach((entry) => {
    entry.content_hash = testHashes[entry.id]!;
  });
  project.project.resources.metrics.forEach((entry) => {
    entry.content_hash = metricHashes[entry.id]!;
  });
  project.project.resources.datasets.forEach((entry) => {
    entry.data_content_hash = datasetHashes[entry.id]!.data;
    entry.metadata_content_hash = datasetHashes[entry.id]!.metadata;
  });
  project.contentHashes = {
    agents: agentHashes,
    datasets: datasetHashes,
    manifest: canonicalHash(project.project),
    metrics: metricHashes,
    tests: testHashes,
  };
  project.projectHash = canonicalHash(project.project);
  return project;
};

/** Builds an in-memory loaded v2 project so resolver tests perform no filesystem I/O. */
const createProject = (): LoadedProject => {
  const agents = [createAgent('support'), createAgent('secondary')];
  const metrics = [createMetric('quality')];
  const datasets: LoadedProject['datasets'] = [
    {
      metadata: {
        schema: DATASET_SCHEMA_VERSION,
        case_schema: 'attest.case/v2',
        id: 'shared',
        name: 'Shared cases',
        case_count: 2,
      },
      cases: datasetCases(),
    },
  ];
  const tests = [
    createTest('alpha', 'support', directCases()),
    createTest('beta', 'secondary', [
      { id: 'beta-case', input: { prompt: 'beta' }, tags: ['smoke', 'api'] },
    ]),
  ];
  const manifest: ProjectManifest = {
    schema: PROJECT_SCHEMA_VERSION,
    project_id: PROJECT_ID,
    name: 'Resolver fixture',
    defaults: { concurrency: 6, eval_timeout_ms: 120_000 },
    resources: {
      agents: agents.map(({ id }) => ({
        schema: AGENT_RESOURCE_SCHEMA_VERSION,
        id,
        path: `attest/agents/${id}.json`,
        content_hash: '0'.repeat(64),
      })),
      tests: tests.map(({ id }) => ({
        schema: TEST_RESOURCE_SCHEMA_VERSION,
        id,
        path: `attest/tests/${id}.json`,
        content_hash: '0'.repeat(64),
      })),
      datasets: datasets.map(({ metadata: { id } }) => ({
        schema: DATASET_SCHEMA_VERSION,
        id,
        data_path: `attest/datasets/${id}.jsonl`,
        data_content_hash: '0'.repeat(64),
        metadata_path: `attest/datasets/${id}.meta.json`,
        metadata_content_hash: '0'.repeat(64),
      })),
      metrics: metrics.map(({ id }) => ({
        schema: METRIC_RESOURCE_SCHEMA_VERSION,
        id,
        path: `attest/metrics/${id}.json`,
        content_hash: '0'.repeat(64),
      })),
    },
  };
  return refreshHashes({
    agents,
    contentHashes: {
      agents: {},
      datasets: {},
      manifest: '0'.repeat(64),
      metrics: {},
      tests: {},
    },
    datasets,
    manifestPath: '/project/attest.project.json',
    metrics,
    project: manifest,
    projectHash: '0'.repeat(64),
    root: '/project',
    tests,
  });
};

const request = (fields: Partial<EvalRunRequest> = {}): EvalRunRequest =>
  ({
    schema: COMMAND_REQUEST_SCHEMA_VERSION,
    command: 'eval.run',
    test_ids: ['alpha'],
    output: 'json',
    ...fields,
  }) as EvalRunRequest;

const options = {
  argv: ['eval', 'run', 'alpha', '--output', 'json'],
} as const;

const captureCliError = (operation: () => unknown): AttestCliError => {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof AttestCliError) return error;
    throw error;
  }
  throw new Error('Expected resolver to throw an AttestCliError.');
};

describe('v2 eval resolver', () => {
  it('expands direct and dataset cases with stable configured indexes and selected hashes', () => {
    const project = createProject();
    const resolved = resolveEvalRun(project, request(), options);

    expect(
      resolved.cases.map(({ case_id, configured_index, source }) => ({
        case_id,
        configured_index,
        source,
      })),
    ).toEqual([
      { case_id: 'direct-smoke', configured_index: 0, source: { kind: 'direct' } },
      { case_id: 'direct-only', configured_index: 1, source: { kind: 'direct' } },
      {
        case_id: 'dataset-smoke',
        configured_index: 2,
        source: { kind: 'dataset', dataset_id: 'shared' },
      },
      {
        case_id: 'dataset-api',
        configured_index: 3,
        source: { kind: 'dataset', dataset_id: 'shared' },
      },
    ]);
    expect(resolved.cases[0]?.metrics[0]?.threshold).toBe(0.9);
    expect(resolved.snapshot.resource_hashes).toEqual({
      agents: [{ id: 'support', content_hash: project.contentHashes.agents.support }],
      tests: [{ id: 'alpha', content_hash: project.contentHashes.tests.alpha }],
      datasets: [
        {
          id: 'shared',
          data_content_hash: project.contentHashes.datasets.shared?.data,
          metadata_content_hash: project.contentHashes.datasets.shared?.metadata,
        },
      ],
      metrics: [{ id: 'quality', content_hash: project.contentHashes.metrics.quality }],
    });
    expect(resolved.snapshotHash).toHaveLength(64);
  });

  it('intersects repeated exact-case and all-tag filters', () => {
    const resolved = resolveEvalRun(
      createProject(),
      request({
        case_ids: ['direct-smoke', 'dataset-smoke', 'dataset-api'],
        tags: ['smoke', 'api'],
      }),
      options,
    );

    expect(resolved.cases.map(({ case_id }) => case_id)).toEqual(['direct-smoke', 'dataset-smoke']);
    expect(resolved.cases.map(({ configured_index }) => configured_index)).toEqual([0, 1]);
  });

  it('resolves all tests plus command, project, test, and built-in execution defaults', () => {
    const project = createProject();
    const allRequest = {
      schema: COMMAND_REQUEST_SCHEMA_VERSION,
      command: 'eval.run',
      all: true,
      concurrency: 8,
      timeout_ms: 90_000,
      baseline_run_id: BASELINE_RUN_ID,
      junit_path: 'artifacts/eval.xml',
      output: 'human',
      watch: true,
    } as const satisfies EvalRunRequest;
    const resolved = resolveEvalRun(project, allRequest, {
      argv: ['eval', 'run', '--all', '--watch'],
    });

    expect(resolved.snapshot.selected_test_ids).toEqual(['alpha', 'beta']);
    expect(resolved.selectedTests.map(({ concurrency }) => concurrency)).toEqual([8, 8]);
    expect(resolved.effectiveCommand).toMatchObject({
      command_path: ['eval', 'run'],
      resolved: {
        concurrency: 8,
        timeout_ms: 90_000,
        output: 'human',
        watch: true,
        baseline_run_id: BASELINE_RUN_ID,
        junit_path: 'artifacts/eval.xml',
      },
    });

    const projectDefaults = resolveEvalRun(project, request(), options);
    expect(projectDefaults.effectiveCommand.resolved).toMatchObject({
      concurrency: 6,
      timeout_ms: 120_000,
      output: 'json',
      watch: false,
    });
    expect(projectDefaults.selectedTests[0]?.concurrency).toBe(2);

    delete project.project.defaults;
    const builtIns = resolveEvalRun(project, request(), options);
    expect(builtIns.effectiveCommand.resolved).toMatchObject({
      concurrency: 4,
      timeout_ms: 60_000,
    });
  });

  it('keeps generated execution ids stable when a case moves into a dataset', () => {
    const directProject = createProject();
    const before = resolveEvalRun(directProject, request({ case_ids: ['direct-smoke'] }), options);
    const movedProject = structuredClone(directProject);
    const movedTest = movedProject.tests.find(({ id }) => id === 'alpha')!;
    const movedCase = movedTest.cases.shift()!;
    const dataset = movedProject.datasets[0]!;
    dataset.cases.unshift(movedCase);
    dataset.metadata.case_count = dataset.cases.length;
    refreshHashes(movedProject);
    const after = resolveEvalRun(movedProject, request({ case_ids: ['direct-smoke'] }), options);

    expect(after.cases[0]?.execution_id).toBe(before.cases[0]?.execution_id);
    expect(after.cases[0]?.source).toEqual({ kind: 'dataset', dataset_id: 'shared' });
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
  });

  it('returns detached deeply immutable resource and case snapshots', () => {
    const project = createProject();
    const resolved = resolveEvalRun(project, request(), options);
    project.tests[0]!.cases[0]!.input = { prompt: 'mutated after resolution' };

    expect(resolved.cases[0]?.case.input).toEqual({ prompt: 'direct smoke' });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.cases[0]?.case.input)).toBe(true);
    expect(Reflect.set(resolved.cases[0]!.case, 'id', 'changed')).toBe(false);
  });

  it('rejects duplicate resource, resolved case, and selection ids deterministically', () => {
    const duplicateResource = createProject();
    duplicateResource.tests.push(structuredClone(duplicateResource.tests[0]!));
    const resourceError = captureCliError(() =>
      resolveEvalRun(duplicateResource, request(), options),
    );
    expect(resourceError.code).toBe('project_invalid');

    const duplicateCase = createProject();
    duplicateCase.tests[0]!.cases.push(structuredClone(duplicateCase.tests[0]!.cases[0]!));
    const caseError = captureCliError(() => resolveEvalRun(duplicateCase, request(), options));
    expect(caseError.code).toBe('project_invalid');

    const duplicateSelection = captureCliError(() =>
      resolveEvalRun(createProject(), request({ test_ids: ['alpha', 'alpha'] }), options),
    );
    expect(duplicateSelection.code).toBe('cli_usage');
    expect(duplicateSelection.details).toMatchObject({ duplicates: ['alpha'] });
  });

  it('rejects missing agents, metrics, tests, cases, and hash coverage before execution', () => {
    const missingAgent = createProject();
    missingAgent.agents = missingAgent.agents.filter(({ id }) => id !== 'support');
    expect(captureCliError(() => resolveEvalRun(missingAgent, request(), options)).code).toBe(
      'project_invalid',
    );

    const missingMetric = createProject();
    missingMetric.metrics = [];
    expect(captureCliError(() => resolveEvalRun(missingMetric, request(), options)).code).toBe(
      'project_invalid',
    );

    const missingHash = createProject();
    const testHashes = { ...missingHash.contentHashes.tests };
    delete testHashes.alpha;
    missingHash.contentHashes = { ...missingHash.contentHashes, tests: testHashes };
    expect(captureCliError(() => resolveEvalRun(missingHash, request(), options)).code).toBe(
      'project_invalid',
    );

    const missingTest = captureCliError(() =>
      resolveEvalRun(createProject(), request({ test_ids: ['absent'] }), options),
    );
    expect(missingTest.code).toBe('resource_not_found');
    expect(missingTest.details).toMatchObject({ missing_ids: ['absent'], resource_type: 'test' });

    const missingCase = captureCliError(() =>
      resolveEvalRun(createProject(), request({ case_ids: ['absent'] }), options),
    );
    expect(missingCase.code).toBe('resource_not_found');
    expect(missingCase.details).toMatchObject({ missing_ids: ['absent'], resource_type: 'case' });
  });

  it('reports empty all/tag selections without creating an empty snapshot', () => {
    const emptyProject = createProject();
    emptyProject.tests = [];
    emptyProject.project.resources.tests = [];
    emptyProject.contentHashes = { ...emptyProject.contentHashes, tests: {} };
    const allRequest = {
      schema: COMMAND_REQUEST_SCHEMA_VERSION,
      command: 'eval.run',
      all: true,
      output: 'json',
    } as const satisfies EvalRunRequest;
    expect(captureCliError(() => resolveEvalRun(emptyProject, allRequest, options)).code).toBe(
      'resource_not_found',
    );

    const tagError = captureCliError(() =>
      resolveEvalRun(createProject(), request({ tags: ['nonexistent'] }), options),
    );
    expect(tagError.code).toBe('resource_not_found');
    expect(tagError.message).toContain('No cases matched');

    const missingSelector = captureCliError(() =>
      resolveEvalRun(
        createProject(),
        {
          schema: COMMAND_REQUEST_SCHEMA_VERSION,
          command: 'eval.run',
          output: 'json',
        } as EvalRunRequest,
        options,
      ),
    );
    expect(missingSelector.code).toBe('cli_missing_input');
    expect(missingSelector.message).toContain('exact test ids or pass `--all`');
  });

  it('is order-stable across non-semantic loaded collection reordering', () => {
    const firstProject = createProject();
    const reordered = structuredClone(firstProject);
    reordered.agents.reverse();
    reordered.datasets.reverse();
    reordered.metrics.reverse();
    reordered.tests.reverse();

    const first = resolveEvalRun(firstProject, request(), options);
    const second = resolveEvalRun(reordered, request(), options);
    expect(second).toEqual(first);
  });

  it('binds snapshot hashes to the current project hash and rejects stale callers', () => {
    const firstProject = createProject();
    const changedProject = structuredClone(firstProject);
    changedProject.projectHash = 'f'.repeat(64);
    const first = resolveEvalRun(firstProject, request(), options);
    const changed = resolveEvalRun(changedProject, request(), options);

    expect(changed.snapshotHash).not.toBe(first.snapshotHash);
    expect(changed.cases[0]?.execution_id).toBe(first.cases[0]?.execution_id);

    const stale = captureCliError(() =>
      resolveEvalRun(changedProject, request(), {
        ...options,
        expectedProjectHash: firstProject.projectHash,
      }),
    );
    expect(stale.code).toBe('project_changed');
    expect(stale.details).toEqual({
      current_hash: changedProject.projectHash,
      expected_hash: firstProject.projectHash,
    });
  });

  it('explicitly rejects v1 project shapes and the removed run alias', () => {
    const v1Project = {
      config_version: 1,
      suites: [],
      projectHash: 'a'.repeat(64),
    } as unknown as LoadedProject;
    const v1Error = captureCliError(() => resolveEvalRun(v1Project, request(), options));
    expect(v1Error.code).toBe('project_invalid');
    expect(v1Error.message).toContain('v1 configs are not discovered');

    const aliasRequest = {
      schema: COMMAND_REQUEST_SCHEMA_VERSION,
      command: 'run',
      test_ids: ['alpha'],
      output: 'json',
    } as unknown as EvalRunRequest;
    const aliasError = captureCliError(() =>
      resolveEvalRun(createProject(), aliasRequest, options),
    );
    expect(aliasError.code).toBe('cli_usage');
    expect(aliasError.message).toContain('`attest run`');
  });
});
