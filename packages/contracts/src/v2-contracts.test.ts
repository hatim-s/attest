import { describe, expect, expectTypeOf, it } from 'vitest';

import { agentResourceSchema, type AgentResource } from './agent-resource-v2.js';
import { testCaseSchema, type TestCase } from './case-v2.js';
import { commandRequestSchema, type CommandRequest } from './command-request-v2.js';
import { datasetResourceSchema, type DatasetResource } from './dataset-resource-v2.js';
import { metricResourceSchema, type MetricResource } from './metric-resource-v2.js';
import {
  projectManifestSchema,
  projectResourcesSchema,
  type ProjectManifest,
} from './project-v2.js';
import { testResourceSchema, type TestResource } from './test-resource-v2.js';
import {
  AGENT_RESOURCE_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  DATASET_SCHEMA_VERSION,
  METRIC_RESOURCE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
} from './versions.js';

const contentHash = 'a'.repeat(64);

const agent: AgentResource = {
  schema: AGENT_RESOURCE_SCHEMA_VERSION,
  id: 'support',
  name: 'Support',
  transport: {
    kind: 'native_cli',
    lifecycle: 'per_case',
    argv: ['node', './src/agent.mjs'],
  },
};

const testCase: TestCase = {
  id: 'refund-basic',
  input: { question: 'How do refunds work?' },
  expected: { contains: '30 days' },
  tags: ['refund'],
};

const dataset: DatasetResource = {
  schema: DATASET_SCHEMA_VERSION,
  case_schema: CASE_SCHEMA_VERSION,
  id: 'refund-regression',
  name: 'Refund regression',
  case_count: 1,
};

const emptyDataset = { ...dataset, case_count: 0 as const };

const metric: MetricResource = {
  schema: METRIC_RESOURCE_SCHEMA_VERSION,
  id: 'correct',
  name: 'Correct',
  definition: {
    kind: 'assertion',
    assertions: [{ contains: { path: '$.output', value: '30 days' } }],
  },
};

const test: TestResource = {
  schema: TEST_RESOURCE_SCHEMA_VERSION,
  id: 'refund',
  name: 'Refund',
  agent_id: agent.id,
  cases: [],
  datasets: [{ dataset_id: dataset.id, tags: ['refund'] }],
  metrics: [{ metric_id: metric.id }],
};

const project: ProjectManifest = {
  schema: PROJECT_SCHEMA_VERSION,
  project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  name: 'support',
  resources: {
    agents: [
      {
        id: agent.id,
        schema: AGENT_RESOURCE_SCHEMA_VERSION,
        path: `attest/agents/${agent.id}.json`,
        content_hash: contentHash,
      },
    ],
    tests: [
      {
        id: test.id,
        schema: TEST_RESOURCE_SCHEMA_VERSION,
        path: `attest/tests/${test.id}.json`,
        content_hash: contentHash,
      },
    ],
    datasets: [
      {
        id: dataset.id,
        schema: DATASET_SCHEMA_VERSION,
        data_path: `attest/datasets/${dataset.id}.jsonl`,
        data_content_hash: contentHash,
        metadata_path: `attest/datasets/${dataset.id}.meta.json`,
        metadata_content_hash: contentHash,
      },
    ],
    metrics: [
      {
        id: metric.id,
        schema: METRIC_RESOURCE_SCHEMA_VERSION,
        path: `attest/metrics/${metric.id}.json`,
        content_hash: contentHash,
      },
    ],
  },
};

const validProjectResources = {
  project,
  agents: [agent],
  tests: [test],
  datasets: [{ metadata: dataset, cases: [testCase] }],
  metrics: [metric],
};

describe('v2 authored resource contracts', () => {
  it('accepts one complete, strictly typed project snapshot', () => {
    expect(projectResourcesSchema.safeParse(validProjectResources).success).toBe(true);
    expectTypeOf(project).toMatchTypeOf<ProjectManifest>();
    expectTypeOf(agent).toMatchTypeOf<AgentResource>();
    expectTypeOf(test).toMatchTypeOf<TestResource>();
    expectTypeOf(testCase).toMatchTypeOf<TestCase>();
    expectTypeOf(dataset).toMatchTypeOf<DatasetResource>();
    expectTypeOf(metric).toMatchTypeOf<MetricResource>();
  });

  it.each([
    ['project', projectManifestSchema, project],
    ['agent', agentResourceSchema, agent],
    ['test', testResourceSchema, test],
    ['case', testCaseSchema, testCase],
    ['dataset', datasetResourceSchema, dataset],
    ['metric', metricResourceSchema, metric],
  ])('rejects unknown fields in the %s contract', (_name, schema, value) => {
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
  });

  it('requires canonical project resource paths', () => {
    const candidate = structuredClone(project);
    candidate.resources.agents[0]!.path = 'agents/support.json';

    const result = projectManifestSchema.safeParse(candidate);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues[0]).toMatchObject({
      path: ['resources', 'agents', 0, 'path'],
      message: 'must equal canonical path attest/agents/support.json',
    });
  });

  it('rejects duplicate generated manifest ids before loading resources', () => {
    const candidate = structuredClone(project);
    candidate.resources.agents.push(structuredClone(candidate.resources.agents[0]!));

    const result = projectManifestSchema.safeParse(candidate);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ['resources', 'agents', 1, 'id'] }),
    );
  });

  it('aggregates manifest, reference, row-count, and resolved-case collision failures', () => {
    const candidate = structuredClone(validProjectResources);
    candidate.project.resources.agents[0]!.id = 'unloaded';
    candidate.tests[0]!.agent_id = 'missing-agent';
    candidate.tests[0]!.metrics[0]!.metric_id = 'missing-metric';
    candidate.tests[0]!.cases.push(structuredClone(testCase));
    candidate.datasets[0]!.metadata.case_count = 2;

    const result = projectResourcesSchema.safeParse(candidate);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        ['project', 'resources', 'agents', 0, 'id'],
        ['agents', 0, 'id'],
        ['datasets', 0, 'metadata', 'case_count'],
        ['tests', 0, 'agent_id'],
        ['tests', 0, 'metrics', 0, 'metric_id'],
        ['tests', 0, 'datasets', 0, 'dataset_id'],
      ]),
    );
  });
});

describe('v2 agent transport contract', () => {
  const transports: AgentResource['transport'][] = [
    agent.transport,
    {
      kind: 'background_cli',
      lifecycle: 'per_run',
      start_argv: ['node', 'server.mjs'],
      readiness: { kind: 'http', url: 'http://127.0.0.1:3000/ready' },
      invoke: { url: 'http://127.0.0.1:3000/invoke', method: 'POST' },
      extraction: { result_pointer: '/output' },
      stop_timeout_ms: 1_000,
    },
    {
      kind: 'jsonl_bridge',
      lifecycle: 'per_run',
      argv: ['node', 'bridge.mjs'],
      concurrency: 'multiplexed',
      cancellation_grace_ms: 500,
    },
    {
      kind: 'http',
      lifecycle: 'external',
      request: { url: 'https://example.com/invoke', method: 'POST' },
      extraction: { result_pointer: '/answer' },
    },
    {
      kind: 'polling',
      lifecycle: 'external',
      submit: { url: 'https://example.com/jobs', method: 'POST' },
      job_id_pointer: '/job_id',
      status_url_template: 'https://example.com/jobs/{{job_id}}',
      status_pointer: '/status',
      success_values: ['done'],
      failure_values: ['failed'],
      extraction: { result_pointer: '/result' },
      minimum_interval_ms: 100,
      maximum_interval_ms: 5_000,
    },
    {
      kind: 'stream',
      lifecycle: 'external',
      framing: 'sse',
      request: { url: 'https://example.com/events', method: 'POST' },
      terminal_pointer: '/type',
      terminal_values: ['result'],
      result_pointer: '/output',
    },
    {
      kind: 'websocket',
      lifecycle: 'per_run',
      url: 'wss://example.com/invoke',
      request_template: { request_id: '{{request_id}}' },
      request_id_pointer: '/request_id',
      extraction: { result_pointer: '/output' },
    },
  ];

  it.each(transports)('accepts the $kind transport definition', (transport) => {
    expect(agentResourceSchema.safeParse({ ...agent, transport }).success).toBe(true);
  });
});

describe('v2 command request contract', () => {
  const base = { schema: COMMAND_REQUEST_SCHEMA_VERSION } as const;
  const importOptions = { format: 'jsonl' as const };
  const requests: CommandRequest[] = [
    { ...base, command: 'project.init', name: 'Support' },
    { ...base, command: 'project.unlock', stale: true },
    { ...base, command: 'agent.add', agent },
    {
      ...base,
      command: 'agent.import',
      source: 'request.curl',
      source_type: 'curl',
      as: agent.id,
      extraction: { result_pointer: '/answer' },
    },
    { ...base, command: 'agent.rename', agent_id: agent.id, new_id: 'support-v2' },
    { ...base, command: 'agent.remove', agent_id: agent.id },
    { ...base, command: 'test.add', test },
    { ...base, command: 'test.case.add', test_id: test.id, case: testCase },
    {
      ...base,
      command: 'test.case.import',
      test_id: test.id,
      source: 'cases.jsonl',
      import: importOptions,
    },
    { ...base, command: 'test.dataset.add', test_id: test.id, dataset: emptyDataset },
    {
      ...base,
      command: 'test.dataset.import',
      test_id: test.id,
      source: 'cases.jsonl',
      as: dataset.id,
      import: importOptions,
    },
    {
      ...base,
      command: 'test.dataset.attach',
      test_id: test.id,
      dataset_id: dataset.id,
    },
    {
      ...base,
      command: 'test.dataset.detach',
      test_id: test.id,
      dataset_id: dataset.id,
    },
    {
      ...base,
      command: 'test.metric.attach',
      test_id: test.id,
      metric_id: metric.id,
    },
    {
      ...base,
      command: 'test.metric.detach',
      test_id: test.id,
      metric_id: metric.id,
    },
    { ...base, command: 'test.rename', test_id: test.id, new_id: 'refund-v2' },
    { ...base, command: 'test.remove', test_id: test.id },
    { ...base, command: 'metric.add', metric },
    {
      ...base,
      command: 'metric.import',
      source: 'metric.json',
      source_type: 'json',
      as: metric.id,
    },
    { ...base, command: 'metric.rename', metric_id: metric.id, new_id: 'correct-v2' },
    { ...base, command: 'metric.remove', metric_id: metric.id },
  ];

  it.each(requests)('accepts the $command normalized request', (request) => {
    expect(commandRequestSchema.safeParse(request).success).toBe(true);
  });

  it('rejects unknown commands and command-specific extra fields', () => {
    expect(commandRequestSchema.safeParse({ ...base, command: 'eval.add' }).success).toBe(false);
    expect(
      commandRequestSchema.safeParse({
        ...base,
        command: 'test.remove',
        test_id: test.id,
        detach: true,
      }).success,
    ).toBe(false);
  });

  it('limits CLI2.7 imports to native JSON and JSONL without mapping policies', () => {
    const request = {
      ...base,
      command: 'test.case.import',
      test_id: test.id,
      source: 'cases.jsonl',
      import: { format: 'jsonl' },
    };

    expect(commandRequestSchema.safeParse(request).success).toBe(true);
    expect(
      commandRequestSchema.safeParse({
        ...request,
        import: { format: 'csv' },
      }).success,
    ).toBe(false);
    expect(
      commandRequestSchema.safeParse({
        ...request,
        import: { format: 'jsonl', mapping: [], sync: 'append', dedupe: 'key' },
      }).success,
    ).toBe(false);
  });

  it('limits dataset add requests to empty metadata without import provenance', () => {
    const request = {
      ...base,
      command: 'test.dataset.add',
      test_id: test.id,
      dataset: emptyDataset,
    };

    expect(commandRequestSchema.safeParse(request).success).toBe(true);
    expect(
      commandRequestSchema.safeParse({ ...request, dataset: { ...emptyDataset, case_count: 1 } })
        .success,
    ).toBe(false);
    expect(
      commandRequestSchema.safeParse({
        ...request,
        dataset: {
          ...emptyDataset,
          provenance: {
            source_type: 'csv',
            mapping: [{ source: 'prompt', destination: 'input' }],
            imported_at: '2026-08-08T00:00:00.000Z',
            source_content_hash: contentHash,
            counts: { read: 0, inserted: 0, updated: 0, skipped: 0 },
          },
        },
      }).success,
    ).toBe(false);
    expect(datasetResourceSchema.safeParse(dataset).success).toBe(true);
  });
});
