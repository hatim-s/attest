import { z } from 'zod';

import { metricResourceSchema } from '../project/resources/metric.js';
import {
  METRIC_PRESET_SCHEMA_ID,
  METRIC_PRESET_SCHEMA_VERSION,
  currentOrLegacyIdentifier,
} from '../schema/identifiers.js';

const metricPresetIdSchema = z.enum([
  'output-equals',
  'output-contains',
  'output-schema',
  'judge-rubric',
  'command',
  'http',
  'tool-called',
  'tool-order',
  'no-tool-errors',
  'trace-span',
]);

/** Encodes one stable, inspectable starting point used by metric authoring wizards. */
const metricPresetSchema = z.strictObject({
  schema: currentOrLegacyIdentifier(METRIC_PRESET_SCHEMA_ID, METRIC_PRESET_SCHEMA_VERSION),
  id: metricPresetIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  required_inputs: z.array(z.string().min(1)),
  configurable_fields: z.array(z.string().min(1)),
  definition: metricResourceSchema.shape.definition,
});

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** Freezes every preset field so stable catalog lookups cannot be mutated by consumers. */
const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
};

/**
 * Publishes defaults rather than hidden wizard prompts while accepting the transitional marker.
 */
const parsedMetricPresets = metricPresetSchema.array().parse([
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'output-equals',
    name: 'Output equals',
    description: 'Require one output or expected-data path to equal a JSON value.',
    required_inputs: ['value'],
    configurable_fields: ['path'],
    definition: {
      kind: 'assertion',
      assertions: [{ equals: { path: '$.output', value: null } }],
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'output-contains',
    name: 'Output contains',
    description:
      'Require one output path to contain a string substring or deep-equal array member.',
    required_inputs: ['value'],
    configurable_fields: ['path'],
    definition: {
      kind: 'assertion',
      assertions: [{ contains: { path: '$.output', value: '' } }],
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'output-schema',
    name: 'Output schema',
    description: 'Validate output against an authored Draft 2020-12 JSON Schema.',
    required_inputs: ['json_schema'],
    configurable_fields: ['path'],
    definition: {
      kind: 'assertion',
      assertions: [{ json_schema: { path: '$.output', schema: { type: 'object' } } }],
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'judge-rubric',
    name: 'Judge rubric',
    description:
      'Score a local fixture later with a provider/model identifier and explicit rubric.',
    required_inputs: ['model', 'rubric'],
    configurable_fields: ['threshold'],
    definition: {
      kind: 'judge',
      model: 'provider/model',
      rubric: 'Score the output against the expected behavior.',
      threshold: 0.8,
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'command',
    name: 'Command metric',
    description: 'Run a trusted local argv array using the native metric envelope.',
    required_inputs: ['argv'],
    configurable_fields: ['cwd', 'env', 'timeout_ms'],
    definition: {
      kind: 'exec',
      argv: ['node', './metrics/metric.mjs'],
      timeout_ms: 30_000,
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'http',
    name: 'HTTP metric',
    description:
      'Describe a trusted HTTP metric and normalized result extraction without executing it.',
    required_inputs: ['url'],
    configurable_fields: ['method', 'headers', 'query', 'body', 'extraction', 'timeout_ms'],
    definition: {
      kind: 'http',
      request: { method: 'POST', url: 'https://example.invalid/metric' },
      extraction: { score_pointer: '/score', pass_pointer: '/pass' },
      timeout_ms: 30_000,
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'tool-called',
    name: 'Tool called',
    description: 'Require matching tool calls, optionally including status, count, and arguments.',
    required_inputs: ['tool_name'],
    configurable_fields: ['status', 'count', 'arguments'],
    definition: {
      kind: 'assertion',
      assertions: [{ tool_calls: { name: 'tool-name', count: 1 } }],
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'tool-order',
    name: 'Tool order',
    description: 'Require tool-call names to appear in one chronological order.',
    required_inputs: ['tool_order'],
    configurable_fields: [],
    definition: {
      kind: 'assertion',
      assertions: [{ tool_calls: { order: ['first-tool', 'second-tool'] } }],
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'no-tool-errors',
    name: 'No tool errors',
    description: 'Reject traces containing failed tool spans.',
    required_inputs: [],
    configurable_fields: [],
    definition: {
      kind: 'assertion',
      assertions: [{ spans: { filter: { kind: 'tool', status: 'error' }, count: 0 } }],
    },
  },
  {
    schema: METRIC_PRESET_SCHEMA_ID,
    id: 'trace-span',
    name: 'Trace span',
    description:
      'Require a trace-capable fixture with spans matching stable fields, attributes, count, or order.',
    required_inputs: [],
    configurable_fields: ['filter', 'count', 'order'],
    definition: {
      kind: 'assertion',
      assertions: [{ spans: { filter: { kind: 'other' }, count: 1 } }],
    },
  },
]);
const METRIC_PRESETS = deepFreeze(parsedMetricPresets);

type MetricPreset = DeepReadonly<z.infer<typeof metricPresetSchema>>;
type MetricPresetId = z.infer<typeof metricPresetIdSchema>;

/** Resolves one stable preset id without exposing array-order assumptions to callers. */
const findMetricPreset = (id: MetricPresetId): MetricPreset => {
  const preset = METRIC_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`Unknown metric preset: ${id}`);
  return preset;
};

export {
  METRIC_PRESETS,
  findMetricPreset,
  metricPresetIdSchema,
  metricPresetSchema,
  type MetricPreset,
  type MetricPresetId,
};
