import { describe, expect, expectTypeOf, it } from 'vitest';

import { agentResourceSchema, type AgentResource } from '../project/resources/agent.js';
import { jsonlBridgeInputSchema, jsonlBridgeOutputSchema } from '../agent/managed-transport.js';
import { testCaseSchema, type TestCase } from '../project/resources/case.js';
import { commandRequestSchema, type CommandRequest } from '../cli/command-request.js';
import { datasetResourceSchema, type DatasetResource } from '../project/resources/dataset.js';
import { metricResourceSchema, type MetricResource } from '../project/resources/metric.js';
import {
  projectManifestSchema,
  projectResourcesSchema,
  type ProjectManifest,
} from '../project/manifest.js';
import { testResourceSchema, type TestResource } from '../project/resources/test.js';
import {
  AGENT_RESOURCE_SCHEMA_ID,
  CASE_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  DATASET_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  PROJECT_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
} from '../schema/identifiers.js';

const contentHash = 'a'.repeat(64);

const agent: AgentResource = {
  schema: AGENT_RESOURCE_SCHEMA_ID,
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
  schema: DATASET_SCHEMA_ID,
  case_schema: CASE_SCHEMA_ID,
  id: 'refund-regression',
  name: 'Refund regression',
  case_count: 1,
};

const emptyDataset = { ...dataset, case_count: 0 as const };

const metric: MetricResource = {
  schema: METRIC_RESOURCE_SCHEMA_ID,
  id: 'correct',
  name: 'Correct',
  definition: {
    kind: 'assertion',
    assertions: [{ contains: { path: '$.output', value: '30 days' } }],
  },
};

const test: TestResource = {
  schema: TEST_RESOURCE_SCHEMA_ID,
  id: 'refund',
  name: 'Refund',
  agent_id: agent.id,
  cases: [],
  datasets: [{ dataset_id: dataset.id, tags: ['refund'] }],
  metrics: [{ metric_id: metric.id }],
};

const project: ProjectManifest = {
  schema: PROJECT_SCHEMA_ID,
  project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  name: 'support',
  resources: {
    agents: [
      {
        id: agent.id,
        schema: AGENT_RESOURCE_SCHEMA_ID,
        path: `attest/agents/${agent.id}.json`,
        content_hash: contentHash,
      },
    ],
    tests: [
      {
        id: test.id,
        schema: TEST_RESOURCE_SCHEMA_ID,
        path: `attest/tests/${test.id}.json`,
        content_hash: contentHash,
      },
    ],
    datasets: [
      {
        id: dataset.id,
        schema: DATASET_SCHEMA_ID,
        data_path: `attest/datasets/${dataset.id}.jsonl`,
        data_content_hash: contentHash,
        metadata_path: `attest/datasets/${dataset.id}.meta.json`,
        metadata_content_hash: contentHash,
      },
    ],
    metrics: [
      {
        id: metric.id,
        schema: METRIC_RESOURCE_SCHEMA_ID,
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

describe('authored resource contracts', () => {
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

describe('agent transport contract', () => {
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
      response_mode: 'mapped',
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
      connection_mode: 'multiplexed',
      framing: 'text_json',
      url: 'wss://example.com/invoke',
      request_template: { request_id: '{{request_id}}' },
      request_id_pointer: '/request_id',
      acknowledgement_pointer: '/acknowledged',
      acknowledgement_values: [true],
      result_pointer: '/output',
      error_pointer: '/error',
      trace_pointer: '/trace',
      open_timeout_ms: 5_000,
      message_idle_timeout_ms: 30_000,
      attempt_timeout_ms: 60_000,
      ping_interval_ms: 10_000,
      close_timeout_ms: 5_000,
      retry_boundary: 'before_acknowledgement',
      replay_after_acknowledgement: false,
    },
  ];

  it.each(transports)('accepts the $kind transport definition', (transport) => {
    expect(agentResourceSchema.safeParse({ ...agent, transport }).success).toBe(true);
  });

  it('accepts RFC 6901 redaction pointers to prototype-named JSON keys', () => {
    expect(
      agentResourceSchema.safeParse({
        ...agent,
        redaction: { event_pointers: ['/constructor', '/prototype', '/__proto__'] },
      }).success,
    ).toBe(true);
  });

  it('requires explicit HTTP response provenance', () => {
    const explicitMapped = transports.find((transport) => transport.kind === 'http');
    expect(explicitMapped).toBeDefined();
    const explicitNative = {
      kind: 'http',
      lifecycle: 'external',
      response_mode: 'attest_envelope',
      request: { url: 'https://example.com/invoke', method: 'POST' },
      extraction: { result_pointer: '' },
    } as const;
    const withoutMode = structuredClone(explicitNative) as Record<string, unknown>;
    Reflect.deleteProperty(withoutMode, 'response_mode');
    expect(agentResourceSchema.safeParse({ ...agent, transport: withoutMode }).success).toBe(false);
    expect(
      agentResourceSchema.parse({ ...agent, transport: explicitNative }).transport,
    ).toMatchObject({ kind: 'http', response_mode: 'attest_envelope' });
    expect(
      agentResourceSchema.parse({ ...agent, transport: explicitMapped }).transport,
    ).toMatchObject({ kind: 'http', response_mode: 'mapped' });
  });

  it('validates all polling invariants', () => {
    const polling = transports.find((transport) => transport.kind === 'polling');
    expect(polling?.kind).toBe('polling');
    if (polling?.kind !== 'polling') throw new Error('Expected polling fixture.');
    expect(
      agentResourceSchema.safeParse({
        ...agent,
        transport: { ...polling, status_url_template: undefined },
      }).success,
    ).toBe(false);
    expect(
      agentResourceSchema.safeParse({
        ...agent,
        transport: { ...polling, status_url_pointer: '/url' },
      }).success,
    ).toBe(false);
    expect(
      agentResourceSchema.safeParse({
        ...agent,
        transport: { ...polling, failure_values: ['done'] },
      }).success,
    ).toBe(false);
    expect(
      agentResourceSchema.safeParse({
        ...agent,
        transport: { ...polling, minimum_interval_ms: 6_000 },
      }).success,
    ).toBe(false);
  });
});

describe('managed JSONL bridge protocol', () => {
  it('accepts correlated request, response, cancel, and cancellation acknowledgement frames', () => {
    expect(
      jsonlBridgeInputSchema.safeParse({
        type: 'request',
        request_id: 'request-1',
        request: {
          protocol: 'attest.agent-invocation',
          run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          case_id: 'one',
          input: {},
        },
      }).success,
    ).toBe(true);
    expect(
      jsonlBridgeInputSchema.safeParse({ type: 'cancel', request_id: 'request-1' }).success,
    ).toBe(true);
    expect(
      jsonlBridgeOutputSchema.safeParse({
        type: 'response',
        request_id: 'request-1',
        response: { protocol: 'attest.agent-invocation', output: 'done' },
      }).success,
    ).toBe(true);
    expect(
      jsonlBridgeOutputSchema.safeParse({ type: 'cancelled', request_id: 'request-1' }).success,
    ).toBe(true);
    expect(
      jsonlBridgeOutputSchema.safeParse({ type: 'response', request_id: 'request-1' }).success,
    ).toBe(false);
  });
});

describe('command request contract', () => {
  const base = { schema: COMMAND_REQUEST_SCHEMA_ID } as const;
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
    {
      ...base,
      command: 'agent.import',
      source: 'agent.json',
      source_type: 'json',
      as: agent.id,
    },
    { ...base, command: 'agent.test', agent_id: agent.id, input: { question: 'ping' } },
    { ...base, command: 'agent.rename', agent_id: agent.id, new_id: 'support-renamed' },
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
    { ...base, command: 'test.rename', test_id: test.id, new_id: 'refund-renamed' },
    { ...base, command: 'test.remove', test_id: test.id },
    { ...base, command: 'metric.add', metric },
    {
      ...base,
      command: 'metric.import',
      source: 'metric.json',
      source_type: 'json',
      as: metric.id,
    },
    { ...base, command: 'metric.rename', metric_id: metric.id, new_id: 'correct-renamed' },
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

  it('accepts the complete tabular import policy and rejects unknown fields', () => {
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
        import: {
          format: 'csv',
          mapping: [
            { destination: 'input.question', source: 'prompt' },
            { destination: 'expected.answer', source: 'ideal' },
          ],
          parse_json: ['tags'],
          key: 'external_id',
          dedupe: 'key',
          on_conflict: 'update',
          sync: 'upsert',
        },
      }).success,
    ).toBe(true);
    expect(
      commandRequestSchema.safeParse({
        ...request,
        import: { format: 'jsonl', destructive_replace: true },
      }).success,
    ).toBe(false);
    expect(
      commandRequestSchema.safeParse({
        ...request,
        import: { mapping: [{ destination: 'unsupported', source: '/value' }] },
      }).success,
    ).toBe(false);
  });

  it('accepts one strict cURL polling import and rejects ambiguous status URLs', () => {
    const request = {
      ...base,
      command: 'agent.import',
      source: 'request.curl',
      source_type: 'curl',
      as: 'polling-agent',
      header_env: { Authorization: 'ATTEST_API_TOKEN' },
      placeholders: [{ target_pointer: '/prompt', input_pointer: '/question' }],
      extraction: { result_pointer: '/answer', error_pointer: '/error' },
      polling: {
        idempotency_header: 'Idempotency-Key',
        job_id_pointer: '/job_id',
        status_url_template: 'https://api.example.test/jobs/{{job_id}}',
        status_pointer: '/status',
        success_values: ['done'],
        failure_values: ['failed'],
        minimum_interval_ms: 100,
        maximum_interval_ms: 1_000,
      },
      timeouts: { connect_ms: 2_000, attempt_ms: 60_000 },
      retry: { retries: 2, backoff: { kind: 'fixed', delay_ms: 100 } },
      limits: { request_bytes: 10_000, response_bytes: 20_000 },
    };

    expect(commandRequestSchema.safeParse(request).success).toBe(true);
    expect(
      commandRequestSchema.safeParse({
        ...request,
        polling: { ...request.polling, status_url_pointer: '/url' },
      }).success,
    ).toBe(false);
    expect(
      commandRequestSchema.safeParse({
        ...request,
        polling: { ...request.polling, minimum_interval_ms: 2_000 },
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
