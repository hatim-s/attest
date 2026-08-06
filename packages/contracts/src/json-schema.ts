import { z } from 'zod';

import { agentRequestSchema, agentResponseSchema } from './agent.js';
import { configSchema } from './config.js';
import { metricRequestSchema, metricResultSchema } from './metric.js';
import { traceSchema } from './trace.js';

type JsonSchemaFragment = Readonly<Record<string, unknown>>;
type ContractJsonSchemaDefinition = {
  schema: z.ZodType;
  invariants: JsonSchemaFragment;
};

const sharedComment =
  'Runtime-only invariants include span time ordering, duplicate identifiers, and metric references.';

const noAdditionalInvariants = { $comment: sharedComment } satisfies JsonSchemaFragment;

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
