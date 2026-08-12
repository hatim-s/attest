import { z } from 'zod';

import { agentRequestSchema, agentResponseSchema } from '../agent/protocol.js';
import { agentResourceSchema } from '../project/resources/agent.js';
import { testCaseSchema } from '../project/resources/case.js';
import {
  cliErrorCatalogSchema,
  cliEventSchema,
  cliHelpSchema,
  cliResultSchema,
} from '../cli/protocol.js';
import { commandRequestSchema } from '../cli/command-request.js';
import { datasetResourceSchema } from '../project/resources/dataset.js';
import { evalCancelRequestSchema, evalCancelResultSchema } from '../eval/cancel.js';
import { evalEventSchema } from '../eval/event.js';
import { evalRunRequestSchema, evalRunSchema } from '../eval/run.js';
import { metricRequestSchema, metricResultSchema } from '../metric/protocol.js';
import { jsonlBridgeInputSchema, jsonlBridgeOutputSchema } from '../agent/managed-transport.js';
import { metricResourceSchema } from '../project/resources/metric.js';
import { metricPresetSchema } from '../metric/presets.js';
import { metricTestFixtureSchema } from '../metric/test-fixture.js';
import { projectManifestSchema } from '../project/manifest.js';
import { testResourceSchema } from '../project/resources/test.js';
import { traceSchema } from '../trace/protocol.js';
import {
  webSocketAttemptEvidenceSchema,
  webSocketCorrelatedMessageSchema,
  webSocketInvocationRequestSchema,
} from '../agent/websocket-contract.js';

type JsonSchemaFragment = Readonly<Record<string, unknown>>;
type ContractJsonSchemaDefinition = {
  schema: z.ZodType;
  invariants: JsonSchemaFragment;
};

const sharedComment =
  'Runtime-only invariants include span time ordering, duplicate identifiers, and metric references.';

const noAdditionalInvariants = { $comment: sharedComment } satisfies JsonSchemaFragment;

const projectRuntimeInvariants = {
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

const CONTRACT_JSON_SCHEMAS = new Map<string, ContractJsonSchemaDefinition>([
  ['agent-request.json', { schema: agentRequestSchema, invariants: agentRequestInvariants }],
  ['agent-response.json', { schema: agentResponseSchema, invariants: agentResponseInvariants }],
  ['trace.json', { schema: traceSchema, invariants: noAdditionalInvariants }],
  ['metric-request.json', { schema: metricRequestSchema, invariants: noAdditionalInvariants }],
  ['metric-result.json', { schema: metricResultSchema, invariants: noAdditionalInvariants }],
  ['project.json', { schema: projectManifestSchema, invariants: projectRuntimeInvariants }],
  ['agent.json', { schema: agentResourceSchema, invariants: projectRuntimeInvariants }],
  ['test.json', { schema: testResourceSchema, invariants: projectRuntimeInvariants }],
  ['case.json', { schema: testCaseSchema, invariants: projectRuntimeInvariants }],
  ['dataset.json', { schema: datasetResourceSchema, invariants: projectRuntimeInvariants }],
  ['metric.json', { schema: metricResourceSchema, invariants: projectRuntimeInvariants }],
  ['metric-preset.json', { schema: metricPresetSchema, invariants: noAdditionalInvariants }],
  [
    'metric-test-fixture.json',
    { schema: metricTestFixtureSchema, invariants: noAdditionalInvariants },
  ],
  ['command-request.json', { schema: commandRequestSchema, invariants: projectRuntimeInvariants }],
  ['eval-run-request.json', { schema: evalRunRequestSchema, invariants: noAdditionalInvariants }],
  ['eval-run.json', { schema: evalRunSchema, invariants: noAdditionalInvariants }],
  ['eval-event.json', { schema: evalEventSchema, invariants: noAdditionalInvariants }],
  [
    'eval-cancel-request.json',
    { schema: evalCancelRequestSchema, invariants: noAdditionalInvariants },
  ],
  [
    'eval-cancel-result.json',
    { schema: evalCancelResultSchema, invariants: noAdditionalInvariants },
  ],
  ['cli-result.json', { schema: cliResultSchema, invariants: noAdditionalInvariants }],
  ['cli-event.json', { schema: cliEventSchema, invariants: noAdditionalInvariants }],
  ['cli-help.json', { schema: cliHelpSchema, invariants: noAdditionalInvariants }],
  ['cli-errors.json', { schema: cliErrorCatalogSchema, invariants: noAdditionalInvariants }],
  [
    'jsonl-bridge-input.json',
    { schema: jsonlBridgeInputSchema, invariants: noAdditionalInvariants },
  ],
  [
    'jsonl-bridge-output.json',
    { schema: jsonlBridgeOutputSchema, invariants: noAdditionalInvariants },
  ],
  [
    'websocket-request.json',
    { schema: webSocketInvocationRequestSchema, invariants: noAdditionalInvariants },
  ],
  [
    'websocket-message.json',
    { schema: webSocketCorrelatedMessageSchema, invariants: noAdditionalInvariants },
  ],
  [
    'websocket-evidence.json',
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
