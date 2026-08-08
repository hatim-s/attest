import { z } from 'zod';

import { agentRequestSchema, agentResponseSchema } from './agent.js';
import { agentResourceSchema } from './agent-resource-v2.js';
import { testCaseSchema } from './case-v2.js';
import {
  cliErrorCatalogSchema,
  cliEventSchema,
  cliHelpSchema,
  cliResultSchema,
} from './cli-protocol.js';
import { commandRequestSchema } from './command-request-v2.js';
import { configSchema } from './config.js';
import { datasetResourceSchema } from './dataset-resource-v2.js';
import { metricRequestSchema, metricResultSchema } from './metric.js';
import { jsonlBridgeInputSchema, jsonlBridgeOutputSchema } from './managed-transport-v1.js';
import { metricResourceSchema } from './metric-resource-v2.js';
import { metricPresetSchema } from './metric-presets.js';
import { metricTestFixtureSchema } from './metric-test-fixture-v1.js';
import { projectManifestSchema } from './project-v2.js';
import { testResourceSchema } from './test-resource-v2.js';
import { traceSchema } from './trace.js';
import {
  webSocketAttemptEvidenceSchema,
  webSocketCorrelatedMessageSchema,
  webSocketInvocationRequestSchema,
} from './websocket-contract-v1.js';

type JsonSchemaFragment = Readonly<Record<string, unknown>>;
type ContractJsonSchemaDefinition = {
  schema: z.ZodType;
  invariants: JsonSchemaFragment;
};

const sharedComment =
  'Runtime-only invariants include span time ordering, duplicate identifiers, and metric references.';

const noAdditionalInvariants = { $comment: sharedComment } satisfies JsonSchemaFragment;

const v2RuntimeInvariants = {
  $comment:
    'Runtime-only invariants include canonical manifest paths, cross-resource references, duplicate identifiers, and resolved case-id collisions.',
} satisfies JsonSchemaFragment;

const agentRequestInvariants = {
  $comment: sharedComment,
  dependentRequired: {
    messages: ['turn_index', 'conversation_id'],
    turn_index: ['messages', 'conversation_id'],
    conversation_id: ['messages', 'turn_index'],
  },
} satisfies JsonSchemaFragment;

const agentResponseInvariants = {
  $comment: sharedComment,
  additionalProperties: true,
  oneOf: [
    { required: ['output'], not: { required: ['error'] } },
    { required: ['error'], not: { required: ['output'] } },
  ],
} satisfies JsonSchemaFragment;

const configInvariants = {
  $comment: sharedComment,
  allOf: [
    {
      properties: {
        agent: {
          if: { properties: { type: { const: 'http' } }, required: ['type'] },
          then: { properties: { url: { pattern: '^https?://' } } },
        },
      },
    },
  ],
  properties: {
    suites: { minItems: 1 },
  },
  $defs: {
    Suite: {
      oneOf: [
        { required: ['cases'], not: { required: ['dataset'] } },
        { required: ['dataset'], not: { required: ['cases'] } },
      ],
    },
    ExecutableMetricDefinition: {
      oneOf: [
        { required: ['command'], not: { required: ['url'] } },
        { required: ['url'], not: { required: ['command'] } },
      ],
    },
    Threshold: {
      anyOf: [
        { required: ['lt'] },
        { required: ['lte'] },
        { required: ['gt'] },
        { required: ['gte'] },
      ],
    },
    AssertionMetricDefinition: {
      properties: { assert: { minItems: 1 } },
    },
    AllAssertionCheck: {
      properties: { all: { minItems: 1 } },
    },
    AnyAssertionCheck: {
      properties: { any: { minItems: 1 } },
    },
  },
} satisfies JsonSchemaFragment;

const CONTRACT_JSON_SCHEMAS = new Map<string, ContractJsonSchemaDefinition>([
  [
    'agent-request.v1alpha1.json',
    { schema: agentRequestSchema, invariants: agentRequestInvariants },
  ],
  [
    'agent-response.v1alpha1.json',
    { schema: agentResponseSchema, invariants: agentResponseInvariants },
  ],
  ['trace.v1alpha1.json', { schema: traceSchema, invariants: noAdditionalInvariants }],
  ['config.v1.json', { schema: configSchema, invariants: configInvariants }],
  [
    'metric-request.v1alpha1.json',
    { schema: metricRequestSchema, invariants: noAdditionalInvariants },
  ],
  [
    'metric-result.v1alpha1.json',
    { schema: metricResultSchema, invariants: noAdditionalInvariants },
  ],
  ['project.v2.json', { schema: projectManifestSchema, invariants: v2RuntimeInvariants }],
  ['agent.v2.json', { schema: agentResourceSchema, invariants: v2RuntimeInvariants }],
  ['test.v2.json', { schema: testResourceSchema, invariants: v2RuntimeInvariants }],
  ['case.v2.json', { schema: testCaseSchema, invariants: v2RuntimeInvariants }],
  ['dataset.v2.json', { schema: datasetResourceSchema, invariants: v2RuntimeInvariants }],
  ['metric.v2.json', { schema: metricResourceSchema, invariants: v2RuntimeInvariants }],
  ['metric-preset.v1.json', { schema: metricPresetSchema, invariants: noAdditionalInvariants }],
  [
    'metric-test-fixture.v1.json',
    { schema: metricTestFixtureSchema, invariants: noAdditionalInvariants },
  ],
  ['command-request.v2.json', { schema: commandRequestSchema, invariants: v2RuntimeInvariants }],
  ['cli-result.v1.json', { schema: cliResultSchema, invariants: noAdditionalInvariants }],
  ['cli-event.v1.json', { schema: cliEventSchema, invariants: noAdditionalInvariants }],
  ['cli-help.v1.json', { schema: cliHelpSchema, invariants: noAdditionalInvariants }],
  ['cli-errors.v1.json', { schema: cliErrorCatalogSchema, invariants: noAdditionalInvariants }],
  [
    'jsonl-bridge-input.v1.json',
    { schema: jsonlBridgeInputSchema, invariants: noAdditionalInvariants },
  ],
  [
    'jsonl-bridge-output.v1.json',
    { schema: jsonlBridgeOutputSchema, invariants: noAdditionalInvariants },
  ],
  [
    'websocket-request.v1.json',
    { schema: webSocketInvocationRequestSchema, invariants: noAdditionalInvariants },
  ],
  [
    'websocket-message.v1.json',
    { schema: webSocketCorrelatedMessageSchema, invariants: noAdditionalInvariants },
  ],
  [
    'websocket-evidence.v1.json',
    { schema: webSocketAttemptEvidenceSchema, invariants: noAdditionalInvariants },
  ],
]);

const isJsonSchemaObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Purely overlays declarative invariant fragments without mutating Zod's generated schema.
 */
const mergeJsonSchemaFragments = (
  generated: Readonly<Record<string, unknown>>,
  fragment: JsonSchemaFragment,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...generated };

  for (const [key, fragmentValue] of Object.entries(fragment)) {
    const generatedValue = generated[key];
    merged[key] =
      isJsonSchemaObject(generatedValue) && isJsonSchemaObject(fragmentValue)
        ? mergeJsonSchemaFragments(generatedValue, fragmentValue)
        : fragmentValue;
  }

  return merged;
};

const sortObjectKeys = (_key: string, value: unknown): unknown => {
  if (!isJsonSchemaObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => {
      if (left === right) {
        return 0;
      }

      return left < right ? -1 : 1;
    }),
  );
};

/** Serializes one registered contract as deterministic Draft 2020-12 JSON Schema. */
const serializeContractSchema = (fileName: string): string => {
  const definition = CONTRACT_JSON_SCHEMAS.get(fileName);
  if (definition === undefined) {
    throw new Error(`Unknown contract JSON Schema file: ${fileName}`);
  }

  const generated = definition.schema.toJSONSchema({
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
  if (!isJsonSchemaObject(generated)) {
    throw new Error(`Zod generated a non-object JSON Schema for ${fileName}`);
  }

  const merged = mergeJsonSchemaFragments(generated, definition.invariants);
  return `${JSON.stringify(merged, sortObjectKeys, 2)}\n`;
};

export {
  CONTRACT_JSON_SCHEMAS,
  mergeJsonSchemaFragments,
  serializeContractSchema,
  type JsonSchemaFragment,
};
