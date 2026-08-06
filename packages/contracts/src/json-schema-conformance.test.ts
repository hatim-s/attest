import * as formatsModule from 'ajv-formats';
import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from './json-schema.js';
import {
  AGENT_PROTOCOL,
  CONFIG_VERSION,
  METRIC_PROTOCOL,
  TRACE_SCHEMA_VERSION,
} from './versions.js';

type ConformanceFixture = {
  name: string;
  fileName: string;
  candidate: unknown;
  valid: boolean;
};

const validTrace = {
  schema: TRACE_SCHEMA_VERSION,
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

const validConfig = {
  config_version: CONFIG_VERSION,
  agent: { type: 'http', url: 'https://example.com/invoke' },
  suites: [{ name: 'smoke', metrics: ['quality'], cases: [{ id: 'one', input: {} }] }],
  metrics: [
    {
      name: 'quality',
      type: 'assertion',
      assert: [{ threshold: { path: '$.output.score', gte: 0.5 } }],
    },
  ],
};

const fixtures: ConformanceFixture[] = [
  {
    name: 'agent request accepts a complete multi-turn envelope',
    fileName: 'agent-request.v1alpha1.json',
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
    fileName: 'agent-request.v1alpha1.json',
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
    fileName: 'agent-response.v1alpha1.json',
    candidate: { protocol: AGENT_PROTOCOL, output: 'Paris', vendor: true },
    valid: true,
  },
  {
    name: 'agent response rejects output together with error',
    fileName: 'agent-response.v1alpha1.json',
    candidate: { protocol: AGENT_PROTOCOL, output: 'Paris', error: { message: 'failed' } },
    valid: false,
  },
  {
    name: 'trace accepts ordered RFC 3339 timestamps',
    fileName: 'trace.v1alpha1.json',
    candidate: validTrace,
    valid: true,
  },
  {
    name: 'trace rejects a missing span kind',
    fileName: 'trace.v1alpha1.json',
    candidate: {
      ...validTrace,
      spans: [{ ...validTrace.spans[0], kind: undefined }],
    },
    valid: false,
  },
  {
    name: 'config accepts union and threshold invariants',
    fileName: 'config.v1.json',
    candidate: validConfig,
    valid: true,
  },
  {
    name: 'config rejects empty assertion lists',
    fileName: 'config.v1.json',
    candidate: {
      ...validConfig,
      metrics: [{ name: 'quality', type: 'assertion', assert: [] }],
    },
    valid: false,
  },
  {
    name: 'metric request accepts a nullable trace',
    fileName: 'metric-request.v1alpha1.json',
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
    fileName: 'metric-request.v1alpha1.json',
    candidate: { protocol: METRIC_PROTOCOL, case: { id: 'one', input: {} }, output: 'Paris' },
    valid: false,
  },
  {
    name: 'metric result accepts the normalized verdict',
    fileName: 'metric-result.v1alpha1.json',
    candidate: { score: 1, pass: true },
    valid: true,
  },
  {
    name: 'metric result rejects a missing pass verdict',
    fileName: 'metric-result.v1alpha1.json',
    candidate: { score: 1 },
    valid: false,
  },
];

/** Documents deliberate runtime checks that Draft 2020-12 cannot represent directly. */
const KNOWN_DIVERGENCES: Readonly<Record<string, string>> = {
  'trace rejects end time before start time':
    'Span ordering compares two parsed timestamps and remains a runtime-only invariant.',
} as const;

const divergenceFixture: ConformanceFixture = {
  name: 'trace rejects end time before start time',
  fileName: 'trace.v1alpha1.json',
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
};

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

  it.each([divergenceFixture])('$name is documented', ({ name, fileName, candidate }) => {
    expect(KNOWN_DIVERGENCES[name]).toBeTruthy();
    expect(getZodSchema(fileName).safeParse(candidate).success).toBe(false);
    expect(getJsonSchemaValidator(fileName)(candidate)).toBe(true);
  });
});

export { KNOWN_DIVERGENCES };
