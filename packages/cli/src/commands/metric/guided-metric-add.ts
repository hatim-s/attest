import { METRIC_PRESETS, type MetricPresetId } from '@attest/contracts';
import { loadCommandProject } from '@attest/local/project';

import { AttestCliError } from '../../errors/index.js';
import {
  requiredMetricInput,
  type MetricAddOptions,
  type RegisterMetricCommandsOptions,
} from './registration-support.js';

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

const guidedChoice = async <Choice extends string>(
  question: string,
  choices: readonly Choice[],
  defaultChoice: Choice,
  path: string,
  context: RegisterMetricCommandsOptions,
): Promise<Choice> => {
  const answer = (await context.interaction.prompt(question)).trim() || defaultChoice;
  if (choices.includes(answer as Choice)) return answer as Choice;
  throw new AttestCliError('cli_usage', `Unknown guided metric choice for ${path}.`, {
    path,
    hint: `Choose one of: ${choices.join(', ')}.`,
  });
};

const guidedTraceCapability = async (
  options: MetricAddOptions,
  context: RegisterMetricCommandsOptions,
): Promise<string> => {
  const loaded = await loadCommandProject({
    project: options.project,
    recover: options.dryRun !== true,
    workingDirectory: context.workingDirectory,
  });
  if (loaded.agents.length === 0) {
    return 'No authored agent is available to verify trace support. Creation remains available before trace evidence exists.';
  }
  const catalog = loaded.agents
    .map(
      (agent) =>
        `  ${agent.id}: ${agent.capabilities?.trace === true ? 'advertises trace support' : 'does not advertise trace support'}`,
    )
    .join('\n');
  const defaultAgent = loaded.agents[0]!.id;
  const selectedId =
    (
      await context.interaction.prompt(
        `Agent trace capabilities:\n${catalog}\nAgent for capability guidance [${defaultAgent}]: `,
      )
    ).trim() || defaultAgent;
  const selected = loaded.agents.find(({ id }) => id === selectedId);
  if (selected === undefined) {
    throw new AttestCliError('cli_usage', 'Unknown agent selected for trace guidance.', {
      path: '<agent-id>',
      hint: `Choose one of: ${loaded.agents.map(({ id }) => id).join(', ')}.`,
    });
  }
  return `Agent ${selected.id} ${
    selected.capabilities?.trace === true
      ? 'advertises trace support'
      : 'does not advertise trace support'
  }. Creation remains available before trace evidence exists.`;
};

/** Collects metric kind, assertion evidence, and operator before any operator value. */
const selectGuidedMetricFields = async (
  options: MetricAddOptions,
  interactive: boolean,
  context: RegisterMetricCommandsOptions,
): Promise<MetricAddOptions> => {
  if (options.preset !== undefined) return options;
  const hasDirectAssertion =
    options.assertJson !== undefined ||
    options.path !== undefined ||
    options.pattern !== undefined ||
    [options.lt, options.lte, options.gt, options.gte].some((value) => value !== undefined);
  if (!interactive || hasDirectAssertion) return options;

  const catalog = METRIC_PRESETS.map((preset, index) => {
    const required =
      preset.required_inputs.length === 0 ? 'none' : preset.required_inputs.join(', ');
    const configurable =
      preset.configurable_fields.length === 0 ? 'none' : preset.configurable_fields.join(', ');
    return `  ${preset.id}${index === 0 ? ' (default)' : ''}: ${preset.description}\n    required: ${required}; configurable: ${configurable}`;
  }).join('\n');
  const kind = await guidedChoice(
    `Metric catalog (${METRIC_PRESETS[0]?.schema ?? 'unknown'}):\n${catalog}\nMetric kind [assertion] (assertion|judge|command|http): `,
    ['assertion', 'judge', 'command', 'http'] as const,
    'assertion',
    'kind',
    context,
  );
  if (kind !== 'assertion') {
    const presetByKind = { judge: 'judge-rubric', command: 'command', http: 'http' } as const;
    return { ...options, preset: presetByKind[kind] };
  }

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
    const presetByOperator: Record<(typeof TRACE_OPERATORS)[number], MetricPresetId> = {
      'tool-called': 'tool-called',
      'tool-order': 'tool-order',
      'no-tool-errors': 'no-tool-errors',
      span: 'trace-span',
    };
    return { ...options, preset: presetByOperator[operator] };
  }

  const operator = await guidedChoice(
    `Assertion operator for $.${evidence} [equals] (${VALUE_OPERATORS.join('|')}): `,
    VALUE_OPERATORS,
    'equals',
    'operator',
    context,
  );
  const guided: MetricAddOptions = { ...options, path: `$.${evidence}` };
  if (operator === 'equals') return { ...guided, preset: 'output-equals' };
  if (operator === 'contains') return { ...guided, preset: 'output-contains' };
  if (operator === 'json-schema') return { ...guided, preset: 'output-schema' };
  if (operator === 'exists') return guided;
  if (operator === 'regex') {
    return {
      ...guided,
      pattern: await requiredMetricInput(
        undefined,
        '--pattern',
        `Assertion preview: evidence=$.${evidence}; operator=regex.\nRegular expression: `,
        true,
        context,
      ),
    };
  }
  return {
    ...guided,
    [operator]: await requiredMetricInput(
      undefined,
      `--${operator}`,
      `Assertion preview: evidence=$.${evidence}; operator=${operator}.\nNumeric threshold: `,
      true,
      context,
    ),
  };
};

/** Fills missing values for the preset selected by flags or guided authoring. */
const fillGuidedMetricFields = async (
  options: MetricAddOptions,
  preset: MetricPresetId | undefined,
  interactive: boolean,
  context: RegisterMetricCommandsOptions,
): Promise<MetricAddOptions> => {
  if (!interactive || preset === undefined) return { ...options, preset };
  const guided: MetricAddOptions = { ...options, preset };
  if ((preset === 'output-equals' || preset === 'output-contains') && guided.value === undefined) {
    guided.value = await requiredMetricInput(
      undefined,
      '--value',
      `Assertion preview: evidence=${guided.path ?? '$.output'}; operator=${preset === 'output-equals' ? 'equals' : 'contains'}.\nJSON value: `,
      true,
      context,
    );
  } else if (
    preset === 'output-schema' &&
    guided.jsonSchema === undefined &&
    guided.jsonSchemaFile === undefined
  ) {
    guided.jsonSchema = await requiredMetricInput(
      undefined,
      '--json-schema',
      `Assertion preview: evidence=${guided.path ?? '$.output'}; operator=json-schema.\nJSON Schema: `,
      true,
      context,
    );
  } else if (preset === 'judge-rubric') {
    guided.model = await requiredMetricInput(
      guided.model,
      '--model',
      'Provider/model: ',
      true,
      context,
    );
    if (guided.rubric === undefined && guided.rubricFile === undefined)
      guided.rubric = await requiredMetricInput(undefined, '--rubric', 'Rubric: ', true, context);
  } else if (preset === 'command') {
    guided.argvJson = await requiredMetricInput(
      guided.argvJson,
      '--argv-json',
      'Metric argv JSON: ',
      true,
      context,
    );
  } else if (preset === 'http') {
    guided.url = await requiredMetricInput(guided.url, '--url', 'Metric URL: ', true, context);
  } else if (preset === 'tool-called') {
    guided.tool = await requiredMetricInput(
      guided.tool,
      '--tool',
      'Assertion preview: evidence=trace; operator=tool-called.\nTool name: ',
      true,
      context,
    );
  } else if (preset === 'tool-order' && (guided.order === undefined || guided.order.length === 0)) {
    const order = await requiredMetricInput(
      undefined,
      '--order',
      'Assertion preview: evidence=trace; operator=tool-order.\nTool names in order (comma-separated): ',
      true,
      context,
    );
    guided.order = order
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  } else if (
    preset === 'trace-span' &&
    guided.spanKind === undefined &&
    guided.spanName === undefined &&
    guided.spanStatus === undefined &&
    guided.attribute === undefined
  ) {
    guided.spanKind =
      (
        await context.interaction.prompt(
          'Assertion preview: evidence=trace; operator=span.\nSpan kind [other]: ',
        )
      ).trim() || 'other';
  }
  return guided;
};

export { fillGuidedMetricFields, selectGuidedMetricFields };
