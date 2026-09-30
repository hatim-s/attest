import type { z } from 'zod';

import { canonicalJson } from '../internal/canonical-json.js';

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
import { jsonlBridgeInputSchema, jsonlBridgeOutputSchema } from '../agent/jsonl-bridge.js';
import { metricResourceSchema } from '../project/resources/metric.js';
import { metricPresetSchema } from '../metric/presets.js';
import { metricTestFixtureSchema } from '../metric/test-fixture.js';
import { projectManifestSchema } from '../project/manifest.js';
import { testResourceSchema } from '../project/resources/test.js';
import { traceSchema } from '../trace/protocol.js';
import {
  webSocketCorrelatedMessageSchema,
  webSocketInvocationRequestSchema,
} from '../agent/websocket-contract.js';
import { webSocketAttemptEvidenceSchema } from '../agent/websocket-evidence.js';

type JsonSchemaFragment = Readonly<Record<string, unknown>>;
type ContractJsonSchemaDefinition = {
  schema: z.ZodType;
  /** Keywords overlaid on the generated schema, including a $comment for runtime-only rules. */
  invariants?: JsonSchemaFragment;
};

const runtimeOnly = (rules: string): JsonSchemaFragment => ({
  $comment: `Runtime-only invariants: ${rules}.`,
});

const traceRules = 'span end_time must not precede start_time, and span ids must be unique';
const assertionRules =
  'regex checks must compile, and threshold checks need at least one comparison';
const agentRequestRules =
  'messages, turn_index, and conversation_id must appear together in the agent request';
const agentResponseRules = 'the agent response carries exactly one of output or error';
const selectionRules = 'selection counts satisfy selected_cases <= matched_cases <= total_cases';
const agentResourceRules = [
  'polling needs exactly one status URL source, ordered intervals, and disjoint terminal values',
  'sandbox destinations are unique after relative-path normalization',
  'HTTP body_encoding requires a body, and raw bodies are strings',
  'stream incremental output pointer and mode appear together',
  'WebSocket timeouts nest, pointers are distinct, and authorization headers use secret references',
].join('; ');

const CONTRACT_JSON_SCHEMAS = new Map<string, ContractJsonSchemaDefinition>([
  [
    'agent-request.json',
    {
      schema: agentRequestSchema,
      invariants: {
        dependentRequired: {
          messages: ['turn_index', 'conversation_id'],
          turn_index: ['messages', 'conversation_id'],
          conversation_id: ['messages', 'turn_index'],
        },
      },
    },
  ],
  [
    'agent-response.json',
    {
      schema: agentResponseSchema,
      invariants: {
        additionalProperties: true,
        oneOf: [
          { required: ['output'], not: { required: ['error'] } },
          { required: ['error'], not: { required: ['output'] } },
        ],
      },
    },
  ],
  ['trace.json', { schema: traceSchema, invariants: runtimeOnly(traceRules) }],
  ['metric-request.json', { schema: metricRequestSchema, invariants: runtimeOnly(traceRules) }],
  ['metric-result.json', { schema: metricResultSchema }],
  [
    'project.json',
    {
      schema: projectManifestSchema,
      invariants: runtimeOnly(
        'resource paths must be canonical for their id, and resource ids must be unique per type',
      ),
    },
  ],
  ['agent.json', { schema: agentResourceSchema, invariants: runtimeOnly(agentResourceRules) }],
  [
    'test.json',
    {
      schema: testResourceSchema,
      invariants: runtimeOnly(
        'agent, metric, and dataset references and resolved case ids are checked when the project loads',
      ),
    },
  ],
  ['case.json', { schema: testCaseSchema }],
  ['dataset.json', { schema: datasetResourceSchema }],
  ['metric.json', { schema: metricResourceSchema, invariants: runtimeOnly(assertionRules) }],
  ['metric-preset.json', { schema: metricPresetSchema, invariants: runtimeOnly(assertionRules) }],
  [
    'metric-test-fixture.json',
    { schema: metricTestFixtureSchema, invariants: runtimeOnly(traceRules) },
  ],
  [
    'command-request.json',
    {
      schema: commandRequestSchema,
      invariants: runtimeOnly(`${agentResourceRules}; ${assertionRules}`),
    },
  ],
  ['eval-run-request.json', { schema: evalRunRequestSchema }],
  [
    'eval-run.json',
    {
      schema: evalRunSchema,
      invariants: runtimeOnly(
        `${selectionRules}, and selection.selected_cases equals the selected case count`,
      ),
    },
  ],
  [
    'eval-event.json',
    {
      schema: evalEventSchema,
      invariants: runtimeOnly(
        `${selectionRules}; sequencing across a stream is checked by the stream parser`,
      ),
    },
  ],
  ['eval-cancel-request.json', { schema: evalCancelRequestSchema }],
  ['eval-cancel-result.json', { schema: evalCancelResultSchema }],
  ['cli-result.json', { schema: cliResultSchema }],
  ['cli-event.json', { schema: cliEventSchema }],
  ['cli-help.json', { schema: cliHelpSchema, invariants: runtimeOnly(assertionRules) }],
  ['cli-errors.json', { schema: cliErrorCatalogSchema }],
  [
    'jsonl-bridge-input.json',
    { schema: jsonlBridgeInputSchema, invariants: runtimeOnly(agentRequestRules) },
  ],
  [
    'jsonl-bridge-output.json',
    { schema: jsonlBridgeOutputSchema, invariants: runtimeOnly(agentResponseRules) },
  ],
  [
    'websocket-request.json',
    { schema: webSocketInvocationRequestSchema, invariants: runtimeOnly(agentRequestRules) },
  ],
  ['websocket-message.json', { schema: webSocketCorrelatedMessageSchema }],
  [
    'websocket-evidence.json',
    {
      schema: webSocketAttemptEvidenceSchema,
      invariants: runtimeOnly('a truncated excerpt carries the sha256 of the full payload'),
    },
  ],
]);

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep-merges invariant keywords into a generated schema without mutating either input. */
const mergeJsonSchemaFragments = (
  generated: Readonly<Record<string, unknown>>,
  fragment: JsonSchemaFragment,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...generated };

  for (const [key, fragmentValue] of Object.entries(fragment)) {
    const generatedValue = generated[key];
    merged[key] =
      isJsonObject(generatedValue) && isJsonObject(fragmentValue)
        ? mergeJsonSchemaFragments(generatedValue, fragmentValue)
        : fragmentValue;
  }

  return merged;
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
  const merged = mergeJsonSchemaFragments(generated, definition.invariants ?? {});
  return `${canonicalJson(merged, 2)}\n`;
};

export { CONTRACT_JSON_SCHEMAS, serializeContractSchema };
