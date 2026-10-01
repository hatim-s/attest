import { METRIC_PRESETS, type MetricPresetId } from '@attest/contracts';
import { loadCommandProject } from '@attest/local/project';

import { AttestCliError } from '../../errors/cli-error.js';
import type { CommandContext } from '../shared/command-context.js';
import { OPERATOR_PROMPTS, PRESET_PROMPTS, askGuidedPrompt } from './guided-metric-prompts.js';
import type { MetricAddOptions } from './register-metric-add-command.js';

const METRIC_KINDS = ['assertion', 'judge', 'command', 'http'] as const;
const ASSERTION_EVIDENCE = ['input', 'output', 'expected', 'trace'] as const;
const VALUE_OPERATORS = [
  'equals',
  'contains',
  'json-schema',
  'regex',
  'exists',
  'lt',
  'lte',
  'gt',
  'gte',
] as const;
const TRACE_OPERATORS = ['tool-called', 'tool-order', 'no-tool-errors', 'span'] as const;

type ValueOperator = (typeof VALUE_OPERATORS)[number];

const PRESET_BY_KIND = {
  judge: 'judge-rubric',
  command: 'command',
  http: 'http',
} as const satisfies Record<Exclude<(typeof METRIC_KINDS)[number], 'assertion'>, MetricPresetId>;

const PRESET_BY_TRACE_OPERATOR = {
  'tool-called': 'tool-called',
  'tool-order': 'tool-order',
  'no-tool-errors': 'no-tool-errors',
  span: 'trace-span',
} as const satisfies Record<(typeof TRACE_OPERATORS)[number], MetricPresetId>;

/** Value operators that are a preset of their own; `exists` needs only the evidence path. */
const PRESET_BY_VALUE_OPERATOR: Partial<Record<ValueOperator, MetricPresetId>> = {
  equals: 'output-equals',
  contains: 'output-contains',
  'json-schema': 'output-schema',
};

const guidedChoice = async <Choice extends string>(
  question: string,
  choices: readonly Choice[],
  defaultChoice: Choice,
  path: string,
  context: CommandContext,
): Promise<Choice> => {
  const answer = (await context.interaction.prompt(question)).trim() || defaultChoice;
  const choice = choices.find((candidate) => candidate === answer);
  if (choice !== undefined) return choice;
  throw new AttestCliError('cli_usage', `Unknown guided metric choice for ${path}.`, {
    path,
    hint: `Choose one of: ${choices.join(', ')}.`,
  });
};

const traceSupport = (agent: { capabilities?: { trace?: boolean } }): string =>
  agent.capabilities?.trace === true
    ? 'advertises trace support'
    : 'does not advertise trace support';

/** Shows which authored agents emit traces, so a trace metric is chosen knowingly. */
const guidedTraceCapability = async (
  options: MetricAddOptions,
  context: CommandContext,
): Promise<string> => {
  const loaded = await loadCommandProject({
    project: options.project,
    recover: options.dryRun !== true,
    workingDirectory: context.workingDirectory,
  });
  const defaultAgent = loaded.agents[0];
  if (defaultAgent === undefined) {
    return 'No authored agent is available to verify trace support. Creation remains available before trace evidence exists.';
  }
  const catalog = loaded.agents.map((agent) => `  ${agent.id}: ${traceSupport(agent)}`).join('\n');
  const selectedId =
    (
      await context.interaction.prompt(
        `Agent trace capabilities:\n${catalog}\nAgent for capability guidance [${defaultAgent.id}]: `,
      )
    ).trim() || defaultAgent.id;
  const selected = loaded.agents.find(({ id }) => id === selectedId);
  if (selected === undefined) {
    throw new AttestCliError('cli_usage', 'Unknown agent selected for trace guidance.', {
      path: '<agent-id>',
      hint: `Choose one of: ${loaded.agents.map(({ id }) => id).join(', ')}.`,
    });
  }
  return `Agent ${selected.id} ${traceSupport(selected)}. Creation remains available before trace evidence exists.`;
};

const presetCatalog = (): string =>
  METRIC_PRESETS.map((preset, index) => {
    const required =
      preset.required_inputs.length === 0 ? 'none' : preset.required_inputs.join(', ');
    const configurable =
      preset.configurable_fields.length === 0 ? 'none' : preset.configurable_fields.join(', ');
    return `  ${preset.id}${index === 0 ? ' (default)' : ''}: ${preset.description}\n    required: ${required}; configurable: ${configurable}`;
  }).join('\n');

/** Asks for the metric kind, assertion evidence, and operator before any operator value. */
const selectGuidedMetricFields = async (
  options: MetricAddOptions,
  interactive: boolean,
  context: CommandContext,
): Promise<MetricAddOptions> => {
  if (options.preset !== undefined) return options;
  const hasDirectAssertion =
    options.assertJson !== undefined ||
    options.path !== undefined ||
    options.pattern !== undefined ||
    [options.lt, options.lte, options.gt, options.gte].some((value) => value !== undefined);
  if (!interactive || hasDirectAssertion) return options;

  const kind = await guidedChoice(
    `Metric catalog (${METRIC_PRESETS[0]?.schema ?? 'unknown'}):\n${presetCatalog()}\nMetric kind [assertion] (assertion|judge|command|http): `,
    METRIC_KINDS,
    'assertion',
    'kind',
    context,
  );
  if (kind !== 'assertion') return { ...options, preset: PRESET_BY_KIND[kind] };

  const evidence = await guidedChoice(
    'Assertion evidence [output] (input|output|expected|trace): ',
    ASSERTION_EVIDENCE,
    'output',
    'evidence',
    context,
  );
  if (evidence === 'trace') {
    const capability = await guidedTraceCapability(options, context);
    const operator = await guidedChoice(
      `${capability}\nTrace operator [tool-called] (tool-called|tool-order|no-tool-errors|span): `,
      TRACE_OPERATORS,
      'tool-called',
      'operator',
      context,
    );
    return { ...options, preset: PRESET_BY_TRACE_OPERATOR[operator] };
  }

  const operator = await guidedChoice(
    `Assertion operator for $.${evidence} [equals] (${VALUE_OPERATORS.join('|')}): `,
    VALUE_OPERATORS,
    'equals',
    'operator',
    context,
  );
  const guided: MetricAddOptions = {
    ...options,
    path: `$.${evidence}`,
    preset: PRESET_BY_VALUE_OPERATOR[operator],
  };
  const step = OPERATOR_PROMPTS[operator];
  return step === undefined ? guided : askGuidedPrompt(step, guided, context);
};

/** Asks for whatever the chosen preset still needs, in the order the preset lists it. */
const fillGuidedMetricFields = async (
  options: MetricAddOptions,
  interactive: boolean,
  context: CommandContext,
): Promise<MetricAddOptions> => {
  const preset = options.preset;
  if (!interactive || preset === undefined) return options;
  let guided = options;
  for (const step of PRESET_PROMPTS[preset] ?? []) {
    if (step.needed(guided)) guided = await askGuidedPrompt(step, guided, context);
  }
  return guided;
};

export { fillGuidedMetricFields, selectGuidedMetricFields };
