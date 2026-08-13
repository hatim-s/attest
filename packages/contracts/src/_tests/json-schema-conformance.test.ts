import * as formatsModule from 'ajv-formats';
import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from '../schema/json-schema.js';
import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  CASE_SCHEMA_ID,
  CLI_ERROR_CATALOG_SCHEMA_ID,
  CLI_EVENT_SCHEMA_ID,
  CLI_HELP_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  DATASET_SCHEMA_ID,
  METRIC_PROTOCOL,
  METRIC_RESOURCE_SCHEMA_ID,
  PROJECT_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  TRACE_SCHEMA_ID,
} from '../schema/identifiers.js';

type ConformanceFixture = {
  name: string;
  fileName: string;
  candidate: unknown;
  valid: boolean;
};

const validTrace = {
  schema: TRACE_SCHEMA_ID,
  trace_id: 'trace-1',
  spans: [
    {
      span_id: 'span-1',
      parent_span_id: null,
      name: 'agent.run',
      kind: 'agent',
      start_time: '2026-08-06T10:15:03Z',
      end_time: '2026-08-06T10:15:04.120Z',
      status: { code: 'ok' },
    },
  ],
};

const contentHash = 'a'.repeat(64);
const validAgent = {
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'support',
  name: 'Support',
  transport: {
    kind: 'native_cli',
    lifecycle: 'per_case',
    argv: ['node', 'agent.mjs'],
  },
};
const validCase = { id: 'refund-basic', input: { question: 'Refund?' } };
const validDataset = {
  schema: DATASET_SCHEMA_ID,
  case_schema: CASE_SCHEMA_ID,
  id: 'refunds',
  name: 'Refunds',
  case_count: 1,
};
const validMetric = {
  schema: METRIC_RESOURCE_SCHEMA_ID,
  id: 'correct',
  name: 'Correct',
  definition: {
    kind: 'assertion',
    assertions: [{ exists: { path: '$.output' } }],
  },
};
const validTest = {
  schema: TEST_RESOURCE_SCHEMA_ID,
  id: 'refund',
  name: 'Refund',
  agent_id: validAgent.id,
  cases: [validCase],
  datasets: [],
  metrics: [{ metric_id: validMetric.id }],
};
const validProject = {
  schema: PROJECT_SCHEMA_ID,
  project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  name: 'support',
  resources: {
    agents: [
      {
        id: validAgent.id,
        schema: AGENT_RESOURCE_SCHEMA_ID,
        path: 'attest/agents/support.json',
        content_hash: contentHash,
      },
    ],
    tests: [],
    datasets: [],
    metrics: [],
  },
};

const validCliHelpCommand = {
  path: ['help'],
  name: 'help',
  summary: 'Show command help.',
  usage: 'attest help [command...] [options]',
  arguments: [],
  options: [],
  subcommands: [],
  aliases: [],
  alias_for: null,
  request_schema: null,
  examples: ['attest help --output json'],
  constraints: [],
};

const fixtures: ConformanceFixture[] = [
  {
    name: 'agent request accepts a complete multi-turn envelope',
    fileName: 'agent-request.json',
    candidate: {
      protocol: AGENT_PROTOCOL,
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      case_id: 'one',
      input: {},
      messages: [],
      turn_index: 0,
      conversation_id: 'conversation-1',
    },
    valid: true,
  },
  {
    name: 'agent request rejects partial multi-turn fields',
    fileName: 'agent-request.json',
    candidate: {
      protocol: AGENT_PROTOCOL,
      run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      case_id: 'one',
      input: {},
      messages: [],
    },
    valid: false,
  },
  {
    name: 'agent response accepts one output and unknown fields',
    fileName: 'agent-response.json',
    candidate: { protocol: AGENT_PROTOCOL, output: 'Paris', vendor: true },
    valid: true,
  },
  {
    name: 'agent response rejects output together with error',
    fileName: 'agent-response.json',
    candidate: { protocol: AGENT_PROTOCOL, output: 'Paris', error: { message: 'failed' } },
    valid: false,
  },
  {
    name: 'trace accepts ordered RFC 3339 timestamps',
    fileName: 'trace.json',
    candidate: validTrace,
    valid: true,
  },
  {
    name: 'trace rejects a missing span kind',
    fileName: 'trace.json',
    candidate: {
      ...validTrace,
      spans: [{ ...validTrace.spans[0], kind: undefined }],
    },
    valid: false,
  },
  {
    name: 'metric request accepts a nullable trace',
    fileName: 'metric-request.json',
    candidate: {
      protocol: METRIC_PROTOCOL,
      case: { id: 'one', input: {} },
      output: 'Paris',
      trace: null,
    },
    valid: true,
  },
  {
    name: 'metric request rejects a missing trace field',
    fileName: 'metric-request.json',
    candidate: { protocol: METRIC_PROTOCOL, case: { id: 'one', input: {} }, output: 'Paris' },
    valid: false,
  },
  {
    name: 'metric result accepts the normalized verdict',
    fileName: 'metric-result.json',
    candidate: { score: 1, pass: true },
    valid: true,
  },
  {
    name: 'metric result rejects a missing pass verdict',
    fileName: 'metric-result.json',
    candidate: { score: 1 },
    valid: false,
  },
  {
    name: 'project accepts its generated manifest',
    fileName: 'project.json',
    candidate: validProject,
    valid: true,
  },
  {
    name: 'project rejects unknown manifest fields',
    fileName: 'project.json',
    candidate: { ...validProject, unexpected: true },
    valid: false,
  },
  {
    name: 'current agent accepts a native transport',
    fileName: 'agent.json',
    candidate: validAgent,
    valid: true,
  },
  {
    name: 'current agent rejects an invalid resource id',
    fileName: 'agent.json',
    candidate: { ...validAgent, id: 'Support Agent' },
    valid: false,
  },
  {
    name: 'current test accepts direct cases and metric references',
    fileName: 'test.json',
    candidate: validTest,
    valid: true,
  },
  {
    name: 'current test rejects unknown fields',
    fileName: 'test.json',
    candidate: { ...validTest, unexpected: true },
    valid: false,
  },
  {
    name: 'case accepts JSON scalar input',
    fileName: 'case.json',
    candidate: { ...validCase, input: 'refund' },
    valid: true,
  },
  {
    name: 'case rejects an invalid id slug',
    fileName: 'case.json',
    candidate: { ...validCase, id: 'refund_basic' },
    valid: false,
  },
  {
    name: 'current dataset accepts metadata for JSONL cases',
    fileName: 'dataset.json',
    candidate: validDataset,
    valid: true,
  },
  {
    name: 'current dataset rejects a negative case count',
    fileName: 'dataset.json',
    candidate: { ...validDataset, case_count: -1 },
    valid: false,
  },
  {
    name: 'current metric accepts an assertion resource',
    fileName: 'metric.json',
    candidate: validMetric,
    valid: true,
  },
  {
    name: 'current metric rejects an empty assertion list',
    fileName: 'metric.json',
    candidate: {
      ...validMetric,
      definition: { kind: 'assertion', assertions: [] },
    },
    valid: false,
  },
  {
    name: 'command request accepts a normalized test add',
    fileName: 'command-request.json',
    candidate: {
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'test.add',
      test: validTest,
    },
    valid: true,
  },
  {
    name: 'command request rejects unknown command fields',
    fileName: 'command-request.json',
    candidate: {
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'test.remove',
      test_id: validTest.id,
      detach: true,
    },
    valid: false,
  },
  {
    name: 'CLI result accepts one strict success document',
    fileName: 'cli-result.json',
    candidate: {
      schema: CLI_RESULT_SCHEMA_ID,
      ok: true,
      command: 'help',
      project_hash_before: null,
      project_hash_after: null,
      result: { found: true },
      warnings: [],
    },
    valid: true,
  },
  {
    name: 'CLI result rejects unknown envelope fields',
    fileName: 'cli-result.json',
    candidate: {
      schema: CLI_RESULT_SCHEMA_ID,
      ok: false,
      command: 'help',
      error: { code: 'cli_usage', message: 'Bad input.', retryable: false },
      unexpected: true,
    },
    valid: false,
  },
  {
    name: 'CLI event accepts one JSONL event document',
    fileName: 'cli-event.json',
    candidate: {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 0,
      time: '2026-08-07T12:00:00.000Z',
      event: 'result',
      data: { ok: true },
    },
    valid: true,
  },
  {
    name: 'CLI event rejects a negative sequence',
    fileName: 'cli-event.json',
    candidate: {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: -1,
      time: '2026-08-07T12:00:00.000Z',
      event: 'result',
      data: { ok: true },
    },
    valid: false,
  },
  {
    name: 'CLI help accepts every required field',
    fileName: 'cli-help.json',
    candidate: { schema: CLI_HELP_SCHEMA_ID, command: validCliHelpCommand },
    valid: true,
  },
  {
    name: 'CLI help rejects a missing deprecation field',
    fileName: 'cli-help.json',
    candidate: {
      schema: CLI_HELP_SCHEMA_ID,
      command: { ...validCliHelpCommand, request_schema: undefined },
    },
    valid: false,
  },
  {
    name: 'CLI error catalog accepts repair metadata',
    fileName: 'cli-errors.json',
    candidate: {
      schema: CLI_ERROR_CATALOG_SCHEMA_ID,
      errors: [
        {
          code: 'cli_usage',
          meaning: 'The command line is invalid.',
          likely_causes: ['An option is missing.'],
          retryable: false,
          exit_code: 2,
          repairs: ['attest help --output json'],
        },
      ],
    },
    valid: true,
  },
  {
    name: 'CLI error catalog rejects success as an error exit code',
    fileName: 'cli-errors.json',
    candidate: {
      schema: CLI_ERROR_CATALOG_SCHEMA_ID,
      errors: [
        {
          code: 'cli_usage',
          meaning: 'The command line is invalid.',
          likely_causes: [],
          retryable: false,
          exit_code: 0,
          repairs: [],
        },
      ],
    },
    valid: false,
  },
];

/** Documents deliberate runtime checks that Draft 2020-12 cannot represent directly. */
const KNOWN_DIVERGENCES: Readonly<Record<string, string>> = {
  'trace rejects end time before start time':
    'Span ordering compares two parsed timestamps and remains a runtime-only invariant.',
  'project rejects a non-canonical resource path':
    'Canonical paths depend on the sibling resource id and remain a runtime-only invariant.',
} as const;

const divergenceFixtures: ConformanceFixture[] = [
  {
    name: 'trace rejects end time before start time',
    fileName: 'trace.json',
    candidate: {
      ...validTrace,
      spans: [
        {
          ...validTrace.spans[0],
          start_time: '2026-08-06T10:15:04Z',
          end_time: '2026-08-06T10:15:03Z',
        },
      ],
    },
    valid: false,
  },
  {
    name: 'project rejects a non-canonical resource path',
    fileName: 'project.json',
    candidate: {
      ...validProject,
      resources: {
        ...validProject.resources,
        agents: [{ ...validProject.resources.agents[0], path: 'agents/support.json' }],
      },
    },
    valid: false,
  },
];

const ajv = new Ajv2020({ allErrors: true, strict: false });
formatsModule.default.default(ajv);
ajv.addFormat('ulid', /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/);

const validators = new Map<string, ValidateFunction>();
for (const fileName of CONTRACT_JSON_SCHEMAS.keys()) {
  const schema = JSON.parse(serializeContractSchema(fileName)) as AnySchema;
  validators.set(fileName, ajv.compile(schema));
}

const getZodSchema = (fileName: string): z.ZodType => {
  const definition = CONTRACT_JSON_SCHEMAS.get(fileName);
  if (definition === undefined) {
    throw new Error(`Missing Zod schema for ${fileName}`);
  }

  return definition.schema;
};

const getJsonSchemaValidator = (fileName: string): ValidateFunction => {
  const validator = validators.get(fileName);
  if (validator === undefined) {
    throw new Error(`Missing JSON Schema validator for ${fileName}`);
  }

  return validator;
};

describe('Zod and generated JSON Schema conformance', () => {
  it.each(fixtures)('$name', ({ fileName, candidate, valid }) => {
    const zodValid = getZodSchema(fileName).safeParse(candidate).success;
    const jsonSchemaValid = getJsonSchemaValidator(fileName)(candidate);

    expect(zodValid).toBe(valid);
    expect(jsonSchemaValid).toBe(valid);
  });

  it.each(divergenceFixtures)('$name is documented', ({ name, fileName, candidate }) => {
    expect(KNOWN_DIVERGENCES[name]).toBeTruthy();
    expect(getZodSchema(fileName).safeParse(candidate).success).toBe(false);
    expect(getJsonSchemaValidator(fileName)(candidate)).toBe(true);
  });
});

export { KNOWN_DIVERGENCES };
